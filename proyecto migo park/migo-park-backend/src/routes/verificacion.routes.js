// Verificación de identidad y propiedad de los espacios.
//  - El arrendador sube sus documentos al publicar (cédula, selfie, certificado/escritura o autorización).
//  - Administrador/soporte los revisan con una lista de chequeo antes de aprobar.
//  - Los documentos se guardan en una carpeta PRIVADA y solo se ven con sesión de administrador/soporte.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middlewares/auth.middleware');
const V = require('../utils/verificacion');

const router = express.Router();

// ---------- subida de archivos (en memoria: se validan ANTES de escribir nada en disco) ----------
const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: V.TIPOS.length },
}).fields(V.TIPOS.map((t) => ({ name: t, maxCount: 1 })));

// ---------- fotos del espacio al publicar (misma carpeta pública que en "Mis espacios") ----------
const MAX_FOTOS = 6;
const MAX_BYTES_FOTO = 5 * 1024 * 1024;
const DIR_FOTOS = path.join(__dirname, '..', '..', 'uploads', 'espacios');
fs.mkdirSync(DIR_FOTOS, { recursive: true });

// Documentos + fotos del espacio en una sola solicitud (solo para /publicar)
const subidaConFotos = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: V.TIPOS.length + MAX_FOTOS },
}).fields([
  ...V.TIPOS.map((t) => ({ name: t, maxCount: 1 })),
  { name: 'fotos', maxCount: MAX_FOTOS },
]);

function subirDocsYFotos(req, res, next) {
  subidaConFotos(req, res, (err) => {
    if (!err) return next();
    const mensaje = err.code === 'LIMIT_FILE_SIZE'
      ? 'Cada archivo puede pesar máximo 8 MB (las fotos, máximo 5 MB).'
      : err.code === 'LIMIT_UNEXPECTED_FILE'
        ? `Puedes subir máximo ${MAX_FOTOS} fotos del espacio.`
        : 'No se pudieron recibir los archivos.';
    res.status(400).json({ error: mensaje });
  });
}

// Tipo REAL de la foto según sus primeros bytes (no se confía en lo que declara el cliente)
function detectarFoto(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: '.png' };
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}

function validarFotos(files) {
  const lista = (files && files.fotos) || [];
  if (lista.length > MAX_FOTOS) {
    const e = new Error(`Puedes subir máximo ${MAX_FOTOS} fotos del espacio.`);
    e.status = 400;
    throw e;
  }
  return lista.map((f, i) => {
    const tipo = detectarFoto(f.buffer);
    if (!tipo) {
      const e = new Error(`La foto ${i + 1} no es una imagen válida (solo JPG, PNG o WEBP).`);
      e.status = 400;
      throw e;
    }
    if (f.size > MAX_BYTES_FOTO) {
      const e = new Error(`La foto ${i + 1} pesa más de 5 MB.`);
      e.status = 400;
      throw e;
    }
    return { buffer: f.buffer, ext: tipo.ext };
  });
}

function subirDocs(req, res, next) {
  subida(req, res, (err) => {
    if (!err) return next();
    const mensaje = err.code === 'LIMIT_FILE_SIZE'
      ? 'Cada archivo puede pesar máximo 8 MB.'
      : 'No se pudieron recibir los archivos.';
    res.status(400).json({ error: mensaje });
  });
}

const esVerdadero = (v) => ['true', '1', 'on', 'si', 'sí'].includes(String(v ?? '').toLowerCase());

// ======================================================
// GET /api/verificacion/mi-estado
// ¿Mi identidad ya está verificada? ¿Qué documentos de identidad ya subí?
// ======================================================
router.get('/mi-estado', verificarToken, async (req, res) => {
  try {
    const u = await pool.query('SELECT identidad_verificada FROM usuarios WHERE id = $1', [req.usuario.id]);
    const docs = await V.cargarDocumentos(pool, req.usuario.id, null);
    res.json({
      identidad_verificada: !!(u.rows[0] && u.rows[0].identidad_verificada),
      identidad_documentos: docs.identidad.map((d) => d.tipo),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar tu estado de verificación' });
  }
});

// ======================================================
// POST /api/verificacion/publicar   (multipart/form-data)
// Publica un espacio JUNTO con sus documentos. Si falta algo, no se crea nada.
// ======================================================
router.post('/publicar', verificarToken, requiereRol('cliente'), subirDocsYFotos, async (req, res) => {
  const b = req.body || {};
  const escritos = [];
  const fotosEscritas = [];
  let client;

  try {
    // ----- datos del espacio (mismas reglas que POST /api/espacios) -----
    const titulo = String(b.titulo || '').trim();
    const direccion = String(b.direccion || '').trim();
    const lat = Number(b.latitud);
    const lng = Number(b.longitud);
    const precio = Number(b.precio_hora);
    const capacidad = Number(b.capacidad_vehiculos);
    const largo = Number(b.largo_metros);
    const ancho = Number(b.ancho_metros);

    if (!titulo || !direccion || b.latitud === '' || b.longitud === '' || !b.precio_hora) {
      return res.status(400).json({ error: 'Faltan campos obligatorios del espacio' });
    }
    if (Number.isNaN(lat) || lat < -90 || lat > 90 || Number.isNaN(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Latitud o longitud fuera de rango' });
    }
    if (Number.isNaN(precio) || precio <= 0) {
      return res.status(400).json({ error: 'El precio por hora debe ser mayor a 0' });
    }
    if (b.capacidad_vehiculos === undefined || b.capacidad_vehiculos === '' || !Number.isInteger(capacidad) || capacidad <= 0) {
      return res.status(400).json({ error: 'La capacidad de vehículos debe ser un número entero mayor a 0' });
    }
    if (b.largo_metros === '' || b.ancho_metros === '' || Number.isNaN(largo) || largo <= 0 || Number.isNaN(ancho) || ancho <= 0) {
      return res.status(400).json({ error: 'El largo y el ancho deben ser mayores a 0' });
    }

    const relacion = String(b.relacion_propietario || '');
    if (!V.RELACIONES.includes(relacion)) {
      return res.status(400).json({ error: 'Indica si eres propietario, arrendatario o administrador del parqueadero' });
    }
    if (!esVerdadero(b.acepta_datos)) {
      return res.status(400).json({ error: 'Debes autorizar el tratamiento de tus datos personales para poder verificarte' });
    }

    // ----- documentos -----
    const archivos = V.validarArchivos(req.files);
    const fotos = validarFotos(req.files);

    const u = (await pool.query('SELECT identidad_verificada FROM usuarios WHERE id = $1', [req.usuario.id])).rows[0];
    const identidadVerificada = !!(u && u.identidad_verificada);
    const previos = await V.cargarDocumentos(pool, req.usuario.id, null);

    const tiposIdentidad = new Set(previos.identidad.map((d) => d.tipo));
    const tiposEspacio = new Set();
    for (const t of Object.keys(archivos)) {
      (V.TIPOS_IDENTIDAD.includes(t) ? tiposIdentidad : tiposEspacio).add(t);
    }

    const faltan = V.documentosFaltantes({ relacion, tiposEspacio, tiposIdentidad, identidadVerificada });
    if (faltan.length > 0) {
      return res.status(400).json({ error: 'Faltan documentos: ' + faltan.join(', ') + '.', faltantes: faltan });
    }

    // ----- todo o nada -----
    client = await pool.connect();
    await client.query('BEGIN');

    const nuevo = await client.query(
      `INSERT INTO espacios_parqueo
         (arrendador_id, titulo, descripcion, direccion, latitud, longitud, precio_hora,
          capacidad_vehiculos, largo_metros, ancho_metros,
          tiene_camara, tiene_porton, tiene_iluminacion, relacion_propietario)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [req.usuario.id, titulo, (b.descripcion || '').trim() || null, direccion, lat, lng, precio,
       capacidad, largo, ancho,
       esVerdadero(b.tiene_camara), esVerdadero(b.tiene_porton), esVerdadero(b.tiene_iluminacion), relacion]
    );
    const espacio = nuevo.rows[0];

    // Fotos del espacio: se guardan en /uploads/espacios y se registran en espacio_media
    const fotosGuardadas = [];
    for (let i = 0; i < fotos.length; i++) {
      const nombre = `espacio${espacio.id}_${Date.now()}_${crypto.randomInt(1e9)}${fotos[i].ext}`;
      await fs.promises.writeFile(path.join(DIR_FOTOS, nombre), fotos[i].buffer, { flag: 'wx' });
      fotosEscritas.push(nombre);
      const m = await client.query(
        `INSERT INTO espacio_media (espacio_id, url, tipo, orden)
         VALUES ($1, $2, 'foto', $3)
         RETURNING id, url`,
        [espacio.id, `/uploads/espacios/${nombre}`, i]
      );
      fotosGuardadas.push(m.rows[0]);
    }

    await client.query('UPDATE usuarios SET consentimiento_datos_fecha = NOW() WHERE id = $1', [req.usuario.id]);

    const r = await V.guardarDocumentos(client, {
      usuarioId: req.usuario.id, espacioId: espacio.id, archivos, identidadVerificada,
    });
    escritos.push(...r.escritos);

    await client.query('COMMIT');
    await V.borrarArchivos(r.reemplazados);

    res.status(201).json({ ...espacio, fotos: fotosGuardadas });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (e) { /* ignorar */ } }
    await V.borrarArchivos(escritos);
    fotosEscritas.forEach((n) => fs.unlink(path.join(DIR_FOTOS, n), () => {}));
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Error al publicar el espacio' });
  } finally {
    if (client) client.release();
  }
});

// ======================================================
// GET /api/verificacion/mis-documentos/:espacioId
// Qué documentos tiene mi espacio y cuáles le faltan
// ======================================================
router.get('/mis-documentos/:espacioId', verificarToken, requiereRol('cliente'), async (req, res) => {
  try {
    const id = Number(req.params.espacioId);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Espacio inválido' });

    const e = (await pool.query(
      'SELECT id, verificado, relacion_propietario, motivo_rechazo FROM espacios_parqueo WHERE id = $1 AND arrendador_id = $2',
      [id, req.usuario.id])).rows[0];
    if (!e) return res.status(404).json({ error: 'Espacio no encontrado' });

    const u = (await pool.query('SELECT identidad_verificada FROM usuarios WHERE id = $1', [req.usuario.id])).rows[0];
    const docs = await V.cargarDocumentos(pool, req.usuario.id, id);

    const faltantes = V.documentosFaltantes({
      relacion: e.relacion_propietario,
      tiposEspacio: new Set(docs.espacio.map((d) => d.tipo)),
      tiposIdentidad: new Set(docs.identidad.map((d) => d.tipo)),
      identidadVerificada: !!u.identidad_verificada,
    });

    res.json({
      verificado: e.verificado,
      motivo_rechazo: e.motivo_rechazo,
      relacion: e.relacion_propietario,
      identidad_verificada: !!u.identidad_verificada,
      documentos: docs.todos.map((d) => ({ tipo: d.tipo, etiqueta: V.ETIQUETAS[d.tipo], fecha: d.fecha })),
      faltantes,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar los documentos' });
  }
});

// ======================================================
// POST /api/verificacion/espacio/:id/documentos   (multipart/form-data)
// Subir o reemplazar documentos de un espacio propio que aún no está verificado
// (por ejemplo, después de un rechazo por un documento ilegible)
// ======================================================
router.post('/espacio/:id/documentos', verificarToken, requiereRol('cliente'), subirDocs, async (req, res) => {
  const escritos = [];
  let client;
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Espacio inválido' });

    const e = (await pool.query(
      'SELECT id, verificado, relacion_propietario FROM espacios_parqueo WHERE id = $1 AND arrendador_id = $2',
      [id, req.usuario.id])).rows[0];
    if (!e) return res.status(404).json({ error: 'Espacio no encontrado' });
    if (e.verificado) return res.status(400).json({ error: 'Este espacio ya está verificado: sus documentos no se pueden cambiar.' });

    let relacion = e.relacion_propietario;
    if (req.body && req.body.relacion_propietario) {
      if (!V.RELACIONES.includes(req.body.relacion_propietario)) {
        return res.status(400).json({ error: 'Relación inválida' });
      }
      relacion = req.body.relacion_propietario;
    }

    const u = (await pool.query(
      'SELECT identidad_verificada, consentimiento_datos_fecha FROM usuarios WHERE id = $1', [req.usuario.id])).rows[0];
    if (!u.consentimiento_datos_fecha && !esVerdadero(req.body && req.body.acepta_datos)) {
      return res.status(400).json({ error: 'Debes autorizar el tratamiento de tus datos personales para poder verificarte' });
    }

    const archivos = V.validarArchivos(req.files);
    if (Object.keys(archivos).length === 0 && relacion === e.relacion_propietario) {
      return res.status(400).json({ error: 'Elige al menos un archivo' });
    }

    client = await pool.connect();
    await client.query('BEGIN');
    if (relacion !== e.relacion_propietario) {
      await client.query('UPDATE espacios_parqueo SET relacion_propietario = $1 WHERE id = $2', [relacion, id]);
    }
    if (!u.consentimiento_datos_fecha) {
      await client.query('UPDATE usuarios SET consentimiento_datos_fecha = NOW() WHERE id = $1', [req.usuario.id]);
    }
    const r = await V.guardarDocumentos(client, {
      usuarioId: req.usuario.id, espacioId: id, archivos, identidadVerificada: !!u.identidad_verificada,
    });
    escritos.push(...r.escritos);
    await client.query('COMMIT');
    await V.borrarArchivos(r.reemplazados);

    res.json({ ok: true });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (e2) { /* ignorar */ } }
    await V.borrarArchivos(escritos);
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Error al guardar los documentos' });
  } finally {
    if (client) client.release();
  }
});

// ======================================================
// GET /api/verificacion/espacio/:id/revision      (administrador / soporte)
// Todo lo que el revisor necesita ver de un espacio
// ======================================================
router.get('/espacio/:id/revision', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Espacio inválido' });

    const e = (await pool.query(
      `SELECT e.*, u.nombre AS arrendador_nombre, u.correo AS arrendador_correo,
              u.telefono AS arrendador_telefono, u.identidad_verificada
       FROM espacios_parqueo e
       JOIN usuarios u ON u.id = e.arrendador_id
       WHERE e.id = $1`, [id])).rows[0];
    if (!e) return res.status(404).json({ error: 'Espacio no encontrado' });

    const fotos = (await pool.query(
      'SELECT id, url, tipo FROM espacio_media WHERE espacio_id = $1 ORDER BY orden, id', [id])).rows;
    const docs = await V.cargarDocumentos(pool, e.arrendador_id, id);

    const faltantes = V.documentosFaltantes({
      relacion: e.relacion_propietario,
      tiposEspacio: new Set(docs.espacio.map((d) => d.tipo)),
      tiposIdentidad: new Set(docs.identidad.map((d) => d.tipo)),
      identidadVerificada: !!e.identidad_verificada,
    });

    res.json({
      espacio: {
        id: e.id, titulo: e.titulo, descripcion: e.descripcion, direccion: e.direccion,
        latitud: e.latitud, longitud: e.longitud, precio_hora: e.precio_hora,
        capacidad_vehiculos: e.capacidad_vehiculos, largo_metros: e.largo_metros, ancho_metros: e.ancho_metros,
        tiene_camara: e.tiene_camara, tiene_porton: e.tiene_porton, tiene_iluminacion: e.tiene_iluminacion,
        verificado: e.verificado, motivo_rechazo: e.motivo_rechazo,
      },
      arrendador: {
        nombre: e.arrendador_nombre, correo: e.arrendador_correo, telefono: e.arrendador_telefono,
        identidad_verificada: !!e.identidad_verificada,
      },
      relacion: e.relacion_propietario,
      fotos,
      documentos: docs.todos.map((d) => ({
        id: d.id, tipo: d.tipo, etiqueta: V.ETIQUETAS[d.tipo], mime: d.mime, fecha: d.fecha,
        ambito: d.espacio_id === null ? 'identidad' : 'espacio',
      })),
      faltantes,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar la revisión' });
  }
});

// ======================================================
// GET /api/verificacion/documentos/:id             (administrador / soporte)
// Descarga un documento (requiere sesión; queda registrado en la terminal)
// ======================================================
router.get('/documentos/:id', verificarToken, requiereRol('administrador', 'soporte'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Documento inválido' });

    const d = (await pool.query('SELECT archivo, mime FROM documentos_verificacion WHERE id = $1', [id])).rows[0];
    if (!d) return res.status(404).json({ error: 'Documento no encontrado' });

    console.log(`[DOCUMENTO] usuario ${req.usuario.id} (${req.usuario.rol}) abrió el documento ${id}`);

    res.set({
      'Content-Type': d.mime,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Content-Disposition': 'inline',
    });
    res.sendFile(path.join(V.DIR_PRIVADO, path.basename(d.archivo)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al abrir el documento' });
  }
});

// ======================================================
// Puerta de aprobación: se monta en server.js sobre PUT /api/espacios/:id/verificar
// No deja aprobar un espacio sin documentos, sin fotos o sin la revisión completa.
// ======================================================
async function exigirRevisionCompleta(req, res, next) {
  try {
    if (req.method !== 'PUT') return next();

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Espacio inválido' });

    const e = (await pool.query(
      `SELECT e.id, e.arrendador_id, e.relacion_propietario, u.identidad_verificada
       FROM espacios_parqueo e JOIN usuarios u ON u.id = e.arrendador_id
       WHERE e.id = $1`, [id])).rows[0];
    if (!e) return res.status(404).json({ error: 'Espacio no encontrado' });

    const checklist = (req.body && req.body.checklist) || {};
    const sinMarcar = V.CHECKLIST.filter((k) => checklist[k] !== true);
    if (sinMarcar.length > 0) {
      return res.status(400).json({ error: 'Completa toda la lista de revisión antes de aprobar.', sin_marcar: sinMarcar });
    }

    const fotos = (await pool.query('SELECT COUNT(*)::int AS n FROM espacio_media WHERE espacio_id = $1', [id])).rows[0].n;
    if (fotos === 0) {
      return res.status(400).json({ error: 'El espacio no tiene fotos. Pídele al arrendador que suba al menos una.' });
    }

    const docs = await V.cargarDocumentos(pool, e.arrendador_id, id);
    const faltantes = V.documentosFaltantes({
      relacion: e.relacion_propietario,
      tiposEspacio: new Set(docs.espacio.map((d) => d.tipo)),
      tiposIdentidad: new Set(docs.identidad.map((d) => d.tipo)),
      identidadVerificada: !!e.identidad_verificada,
    });
    if (faltantes.length > 0) {
      return res.status(400).json({ error: 'Faltan documentos: ' + faltantes.join(', ') + '.', faltantes });
    }

    // Queda constancia de quién revisó qué
    await pool.query(
      'UPDATE espacios_parqueo SET checklist_verificacion = $1 WHERE id = $2',
      [JSON.stringify({ ...checklist, revisado_por: req.usuario.id, fecha: new Date().toISOString() }), id]
    );
    await pool.query(
      `UPDATE usuarios SET identidad_verificada = TRUE, identidad_verificada_por = $1, identidad_fecha = NOW()
       WHERE id = $2 AND identidad_verificada = FALSE`,
      [req.usuario.id, e.arrendador_id]
    );

    next(); // ahora sí: la ruta original aprueba el espacio
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al validar la revisión' });
  }
}

router.puertaAprobacion = [verificarToken, requiereRol('administrador', 'soporte'), exigirRevisionCompleta];

module.exports = router;