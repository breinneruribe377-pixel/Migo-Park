const pool = require('../db');

const MINUTOS_AVISO = 15;   // se avisa cuando faltan 15 minutos o menos para que termine la reserva

// Envía UN recordatorio por reserva confirmada que está por terminar.
// La marca recordatorio_enviado evita que se repita el aviso.
async function enviarRecordatorios() {
  const r = await pool.query(
    `WITH por_avisar AS (
       UPDATE reservas SET recordatorio_enviado = TRUE
       WHERE estado = 'confirmada'
         AND recordatorio_enviado = FALSE
         AND fecha_fin > NOW()
         AND fecha_fin <= NOW() + make_interval(mins => $1::int)
       RETURNING id, conductor_id, espacio_id, fecha_fin
     )
     INSERT INTO notificaciones (usuario_id, tipo, mensaje)
     SELECT p.conductor_id, 'recordatorio_fin',
            'Tu reserva en "' || e.titulo || '" termina a las ' || to_char(p.fecha_fin, 'HH24:MI') ||
            '. Desocupa el espacio a tiempo para evitar inconvenientes.'
     FROM por_avisar p JOIN espacios_parqueo e ON e.id = p.espacio_id`,
    [MINUTOS_AVISO]
  );
  return r.rowCount;
}

// Revisa cada minuto (se llama desde server.js)
function iniciarRecordatorios() {
  const correr = () => enviarRecordatorios().catch((err) => console.error('Error en recordatorios:', err));
  void correr();
  return setInterval(correr, 60 * 1000);
}

module.exports = { enviarRecordatorios, iniciarRecordatorios };