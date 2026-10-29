const express = require('express');
const pool = require('../db');
const { verificarToken, requiereRol } = require('../middlewares/auth.middleware');
const { MINUTOS_PARA_PAGAR, actualizarReservas } = require('../utils/reservas');

const router = express.Router();

const COMISION_PORCENTAJE = 0.10;
const MAX_HORAS_RESERVA = 24 * 30;            // máximo 30 días por reserva
const REQUIERE_VEHICULO_VERIFICADO = false;   // pon true si quieres exigir una placa verificada para reservar

const fmt = (n) => '$' + Number(n).toLocaleString('es-CO');

// POST /api/reservas -> crea una reserva (queda pendiente de pago por 15 minutos)
router.post('/', verificarToken, requiereRol('cliente'), async (req, res) => {
  const { espacio_id, fecha_inicio, fecha_fin } = req.body;
  if (!espacio_id || !fecha_inicio || !fecha_fin) {
    return res.status(400).json({ error: 'espacio_id, fecha_inicio y fecha_fin son obligatorios' });
  }

  const inicio = new Date(fecha_inicio);
  const fin = new Date(fecha_fin);
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fin.getTime()) || fin <= inicio) {
    return res.status(400).json({ error: 'Fechas inválidas' });
  }
  if (inicio < new Date(Date.now() - 60 * 1000)) {
    return res.status(400).json({ error: 'La fecha de inicio no puede estar en el pasado' });
  }
  const horas = (fin - inicio) / (1000 * 60 * 60);
  if (horas < 1) return res.status(400).json({ error: 'La reserva mínima es de 1 hora' });
  if (horas > MAX_HORAS_RESERVA) return res.status(400).json({ error: 'La reserva máxima es de 30 días' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await actualizarReservas(client);

    // FOR UPDATE bloquea el espacio: dos personas no pueden reservar el mismo horario a la vez
    const espacioResult = await client.query(
      `SELECT * FROM espacios_parqueo
       WHERE id = $1 AND verificado = TRUE AND estado = 'disponible' FOR UPDATE`,
      [espacio_id]
    );
    if (espacioResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Espacio no encontrado, no verificado o no disponible' });
    }
    const espacio = espacioResult.rows[0];

    if (espacio.arrendador_id === req.usuario.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No puedes reservar tu propio espacio' });
    }

    if (REQUIERE_VEHICULO_VERIFICADO) {
      const veh = await client.query(
        'SELECT 1 FROM vehiculos WHERE conductor_id = $1 AND verificado = TRUE LIMIT 1',
        [req.usuario.id]
      );
      if (veh.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Necesitas al menos un vehículo verificado para reservar' });
      }
    }

    // Días bloqueados por el arrendador en el calendario de disponibilidad
    const bloqueado = await client.query(
      `SELECT 1 FROM disponibilidad_espacio
       WHERE espacio_id = $1 AND habilitado = FALSE AND fecha BETWEEN $2::date AND $3::date LIMIT 1`,
      [espacio_id, inicio, fin]
    );
    if (bloqueado.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'El arrendador bloqueó alguno de esos días' });
    }

    // Cruce de horarios con otras reservas activas
    const cruce = await client.query(
      `SELECT 1 FROM reservas
       WHERE espacio_id = $1
         AND estado IN ('pendiente', 'en_proceso', 'confirmada')
         AND $2 < fecha_fin AND $3 > fecha_inicio
       LIMIT 1`,
      [espacio_id, inicio, fin]
    );
    if (cruce.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ese horario ya está reservado. Elige otro.' });
    }

    // El precio SIEMPRE se calcula en el servidor
    const subtotal = Number((horas * Number(espacio.precio_hora)).toFixed(2));
    const comision = Number((subtotal * COMISION_PORCENTAJE).toFixed(2));
    const total = Number((subtotal + comision).toFixed(2));

    const resultado = await client.query(
      `INSERT INTO reservas (espacio_id, conductor_id, fecha_inicio, fecha_fin, subtotal, comision, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *, $8::int * 60 AS segundos_restantes`,
      [espacio_id, req.usuario.id, inicio, fin, subtotal, comision, total, MINUTOS_PARA_PAGAR]
    );

    await client.query('COMMIT');
    res.status(201).json(resultado.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al crear la reserva' });
  } finally {
    client.release();
  }
});

// GET /api/reservas/mias -> historial del usuario, con estado del pago y tiempo restante para pagar
router.get('/mias', verificarToken, async (req, res) => {
  try {
    await actualizarReservas(pool);
    const resultado = await pool.query(
      `SELECT r.*,
              e.titulo AS espacio_titulo,
              e.direccion AS espacio_direccion,
              p.id AS pago_id,
              p.estado AS pago_estado,
              p.metodo_pago,
              (c.id IS NOT NULL) AS ya_calificada,
              CASE WHEN r.estado IN ('pendiente', 'en_proceso')
                   THEN GREATEST(0, EXTRACT(EPOCH FROM
                          (r.fecha_creacion + make_interval(mins => $2::int) - NOW()))::int)
              END AS segundos_restantes
       FROM reservas r
       JOIN espacios_parqueo e ON e.id = r.espacio_id
       LEFT JOIN LATERAL (
         SELECT id, estado, metodo_pago FROM pagos WHERE reserva_id = r.id ORDER BY id DESC LIMIT 1
       ) p ON TRUE
       LEFT JOIN calificaciones c ON c.reserva_id = r.id
       WHERE r.conductor_id = $1
       ORDER BY r.fecha_creacion DESC`,
      [req.usuario.id, MINUTOS_PARA_PAGAR]
    );
    res.json(resultado.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar tus reservas' });
  }
});

// GET /api/reservas/espacio/:id/ocupado -> horarios ya tomados de un espacio (no expone datos de personas)
router.get('/espacio/:id/ocupado', verificarToken, async (req, res) => {
  try {
    await actualizarReservas(pool);
    const resultado = await pool.query(
      `SELECT fecha_inicio, fecha_fin FROM reservas
       WHERE espacio_id = $1
         AND estado IN ('pendiente', 'en_proceso', 'confirmada')
         AND fecha_fin > NOW()
       ORDER BY fecha_inicio ASC`,
      [req.params.id]
    );
    res.json(resultado.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar los horarios ocupados' });
  }
});

// PUT /api/reservas/:id/cancelar -> el conductor cancela su reserva y se calcula el reembolso
//   Sin pagar: se cancela sin reembolso (no hay nada que devolver)
//   Pagada: más de 24 h antes = 100% | entre 2 y 24 h = 50% | menos de 2 h = 0% | ya empezó = no se puede
router.put('/:id/cancelar', verificarToken, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await actualizarReservas(client);

    const r = await client.query(
      `SELECT r.*, e.arrendador_id, e.titulo AS espacio_titulo
       FROM reservas r JOIN espacios_parqueo e ON e.id = r.espacio_id
       WHERE r.id = $1 AND r.conductor_id = $2 FOR UPDATE OF r`,
      [id, req.usuario.id]
    );
    if (r.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Reserva no encontrada o no te pertenece' });
    }
    const reserva = r.rows[0];

    if (!['pendiente', 'en_proceso', 'confirmada'].includes(reserva.estado)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Esta reserva ya está ${reserva.estado}` });
    }

    let porcentaje = 0;
    if (reserva.estado === 'confirmada') {
      const horasParaInicio = (new Date(reserva.fecha_inicio) - new Date()) / (1000 * 60 * 60);
      if (horasParaInicio <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'No puedes cancelar una reserva que ya empezó' });
      }
      porcentaje = horasParaInicio >= 24 ? 100 : horasParaInicio >= 2 ? 50 : 0;
    }
    const reembolso = Number((Number(reserva.total) * porcentaje / 100).toFixed(2));

    const actualizada = await client.query(
      `UPDATE reservas SET estado = 'cancelada', monto_reembolso = $1, fecha_cancelacion = NOW()
       WHERE id = $2 RETURNING *`,
      [reembolso, id]
    );
    // Si había un pago sin completar, queda como fallido
    await client.query(
      `UPDATE pagos SET estado = 'fallido' WHERE reserva_id = $1 AND estado IN ('pendiente', 'en_proceso')`,
      [id]
    );

    // Notificaciones (las tablas ya existen; la pantalla de notificaciones viene después)
    const msgCliente = reserva.estado === 'confirmada'
      ? `Cancelaste tu reserva en "${reserva.espacio_titulo}". Reembolso: ${porcentaje}% (${fmt(reembolso)}).`
      : `Cancelaste tu reserva pendiente en "${reserva.espacio_titulo}".`;
    await client.query(
      `INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1, 'reserva_cancelada', $2)`,
      [req.usuario.id, msgCliente]
    );
    if (reserva.estado === 'confirmada') {
      await client.query(
        `INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1, 'reserva_cancelada', $2)`,
        [reserva.arrendador_id, `Se canceló una reserva en tu espacio "${reserva.espacio_titulo}".`]
      );
    }

    await client.query('COMMIT');
    res.json({ reserva: actualizada.rows[0], porcentaje_reembolso: porcentaje, monto_reembolso: reembolso });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Error al cancelar la reserva' });
  } finally {
    client.release();
  }
});

// PUT /api/reservas/:id/estado -> uso administrativo
//   Staff: cualquier estado | Arrendador: solo marcar "completada" | Conductor: NO (usa /cancelar)
router.put('/:id/estado', verificarToken, async (req, res) => {
  const { id } = req.params;
  const { estado } = req.body;
  const ESTADOS_VALIDOS = ['pendiente', 'en_proceso', 'confirmada', 'completada', 'cancelada'];
  if (!ESTADOS_VALIDOS.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }

  try {
    const reservaResult = await pool.query(
      `SELECT r.*, e.arrendador_id FROM reservas r JOIN espacios_parqueo e ON e.id = r.espacio_id WHERE r.id = $1`,
      [id]
    );
    if (reservaResult.rows.length === 0) return res.status(404).json({ error: 'Reserva no encontrada' });

    const reserva = reservaResult.rows[0];
    const esStaff = ['administrador', 'soporte'].includes(req.usuario.rol);
    const esArrendador = reserva.arrendador_id === req.usuario.id;

    if (!esStaff && !(esArrendador && estado === 'completada')) {
      return res.status(403).json({ error: 'No tienes permiso para cambiar el estado de esta reserva' });
    }

    const resultado = await pool.query('UPDATE reservas SET estado = $1 WHERE id = $2 RETURNING *', [estado, id]);
    res.json(resultado.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el estado de la reserva' });
  }
});

module.exports = router;