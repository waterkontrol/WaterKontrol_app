// Cargar las variables de entorno desde el archivo .env
require('dotenv').config();

// Importar las librerías necesarias
const express = require('express');
const { Pool } = require('pg');
const mqtt = require('mqtt');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const cookieParser = require('cookie-parser');
const saltRounds = 10;
var cors = require('cors');
const admin = require('firebase-admin');
// const serviceAccount = require('./serviceAccountKey.json');
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT);

// --- CONFIGURACIÓN DE EXPRESS ---
const app = express();

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

// MIDDLEWARE PRINCIPAL
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ✅ CORS explícito para evitar bloqueos en frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
// app.use(cors({credentials: true,
//   origin: ['http://localhost:8080', 'http://localhost:8081', 'https://waterkontrolapp-production.up.railway.app']
// }))

// ===================================================================================
// LÓGICA DE CONEXIÓN A LA BASE DE DATOS Y BCRYPT
// ===================================================================================
console.log('🔧 Intentando conectar a la base de datos...');
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
console.log('📋 DATABASE_URL:', process.env.DATABASE_URL ? '✅ Definida' : '❌ NO DEFINIDA');
console.log(`📋 Entorno: ${isProduction ? 'Producción (Railway)' : 'Desarrollo'}`);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

const testDatabaseConnection = async () => {
  try {
    const client = await pool.connect();
    client.release();
    console.log('✅ Conexión a PostgreSQL exitosa.');
    return true;
  } catch (err) {
    console.error('❌ Error de conexión a PostgreSQL:', err.message);
    return false;
  }
};

// ===================================================================================
// LÓGICA DE CONEXIÓN Y MANEJO DE MQTT
// ===================================================================================
let mqttClient;

// const connectMqtt = () => {
  
//   const url = process.env.MQTT_BROKER_URL || 'mqtt://test.mosquitto.org';
//   mqttClient = mqtt.connect(url);

//   mqttClient.on('connect', () => {
//     console.log('✅ Conexión a MQTT Broker exitosa.');
//     const telemetryTopic = 'mk-208/VB/E8:6B:EA:DE:ED:74';
//     mqttClient.subscribe(telemetryTopic, (err) => {
//       if (!err) {
//         console.log(`✅ Suscrito al topic de telemetría general: ${telemetryTopic}`);
//       } else {
//         console.error(`❌ Error al suscribirse a ${telemetryTopic}:`, err);
//       }
//     });
//   });
//   return mqttClient;
// };

const connectMqtt = async () => {

  const result = await pool.query('SELECT topic FROM registro');
 
  const url = process.env.MQTT_BROKER_URL || 'mqtt://test.mosquitto.org';
  mqttClient = mqtt.connect(url);

  mqttClient.on('connect', () => {
    console.log('✅ Conexión a MQTT Broker exitosa.');
    // const telemetryTopic = 'mk-208/VB/E8:6B:EA:DE:ED:74';
    
    result.rows.forEach(row => {
      const telemetryTopic = row.topic.concat('/out');

      mqttClient.subscribe(telemetryTopic, (err) => {
        if (!err) {
          console.log(`✅ Suscrito al topic de telemetría general: ${telemetryTopic}`);
        } else {
          console.error(`❌ Error al suscribirse a ${telemetryTopic}:`, err);
        }
      });
    });

  });
  return mqttClient;
};

// connectMqtt();

// ===================================================================================
// FUNCIONES DE AUTENTICACIÓN
// ===================================================================================

const isAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (authHeader) {
    // Example for Bearer token: "Bearer <token_string>"
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      // const token = req.cookies.session_token;
      console.log('🔐 Verificando token de sesión:', authHeader.split(' ')[1]);
      // if (!token) {
      //   return res.status(401).send({ message: 'No autorizado. Inicie sesión.', redirect: '/login.html' });
      // }

      pool.query('SELECT usuario_id FROM sesion WHERE token = $1 AND expira_en > NOW()', [token])
        .then(result => {
          if (result.rows.length === 0) {
            res.clearCookie('session_token');
            return res.status(401).send({ message: 'Sesión expirada. Por favor, vuelva a iniciar sesión.', redirect: '/login.html' });
          }
          req.userId = result.rows[0].usuario_id;
          next();
        })
        .catch(err => {
          console.error('Error al verificar sesión:', err);
          res.status(500).send({ message: 'Error interno del servidor.' });
      });
  } else {
    res.status(401).send({ message: 'No autorizado. Inicie sesión.', redirect: '/login.html' });
  }
}

};

// ===================================================================================
// CONFIGURACIÓN DE NODEMAILER
// ===================================================================================

const RAILWAY_API_URL = process.env.RAILWAY_API_URL || process.env.RAILWAY_PUBLIC_DOMAIN || 'http://localhost:3000';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ===================================================================================
// RUTAS DE AUTENTICACIÓN
// ===================================================================================

// POST /auth/register
app.post('/auth/register', async (req, res) => {
  const { nombre, correo, clave } = req.body;
  if (!nombre || !correo || !clave) {
    return res.status(400).json({ message: 'Faltan datos.' });
  }

  try {
    const hashed = await bcrypt.hash(clave, saltRounds);
    const result = await pool.query(
      'INSERT INTO usuario (nombre, correo, clave) VALUES ($1, $2, $3) RETURNING usr_id',
      [nombre, correo, hashed]
    );
    res.status(201).json({ message: 'Usuario registrado exitosamente.' });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ message: 'El correo ya está registrado.' });
    }
    console.error('Error al registrar usuario:', error);
    res.status(500).json({ message: 'Error interno al registrar usuario.' });
  }
});

// POST /auth/login
app.post('/auth/login', async (req, res) => {
  const { correo, clave } = req.body;
  if (!correo || !clave) {
    return res.status(400).json({ message: 'Faltan datos.' });
  }

  try {
    const result = await pool.query('SELECT usr_id, clave FROM usuario WHERE correo = $1', [correo]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Credenciales incorrectas.' });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(clave, user.clave);
    if (!match) {
      return res.status(401).json({ message: 'Credenciales incorrectas.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    
    await pool.query(
      'INSERT INTO sesion (token, usuario_id, expira_en) VALUES ($1, $2, NOW() + INTERVAL \'7 days\')',
      [token, user.usr_id]
    );

    res.cookie('session_token', token, { secure: true, sameSite: 'None', httpOnly: true });

    // res.setHeader('Set-Cookie', [
    //   'session_token='+token+'; SameSite=None; Secure; HttpOnly; Max-Age=3600'
    // ]);

    res.status(200).json({ message: 'Inicio de sesión exitoso.', token: token, usr_id: user.usr_id });
    // res.send({ message: 'Inicio de sesión exitoso.', token: token });
  } catch (error) {
    console.error('Error al iniciar sesión:', error);
    return res.status(500).json({ message: 'Error interno del servidor.' });
  }
});

// POST /auth/logout
app.post('/auth/logout', isAuth, async (req, res) => {
  const token = req.cookies.session_token;
  await pool.query('DELETE FROM sesion WHERE token = $1', [token]);
  res.clearCookie('session_token');
  res.status(200).json({ message: 'Sesión cerrada.' });
});

// POST /auth/forgot
app.post('/auth/forgot', async (req, res) => {
  const { correo } = req.body;
  if (!correo) return res.status(400).json({ message: 'Falta el correo.' });

  try {
    const user = await pool.query('SELECT usuario_id FROM usuario WHERE correo = $1', [correo]);
    if (user.rows.length === 0) return res.status(200).json({ message: 'Si el correo existe, se enviará el enlace.' });

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO reset_tokens (token, usuario_id, expira_en) VALUES ($1, $2, NOW() + INTERVAL \'1 hour\')',
      [token, user.rows[0].usuario_id]
    );

    const resetLink = `${RAILWAY_API_URL}/reset.html?token=${token}`;
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: correo,
      subject: 'Restablece tu contraseña - WaterKontrol',
      html: `<p>Haz clic en el siguiente enlace para restablecer tu contraseña:</p><a href="${resetLink}">${resetLink}</a>`
    });

    res.status(200).json({ message: 'Si el correo existe, se enviará el enlace.' });
  } catch (err) {
    console.error('Error al enviar correo:', err);
    res.status(500).json({ message: 'Error al enviar correo.' });
  }
});

// POST /auth/reset
app.post('/auth/reset', async (req, res) => {
  const { token, nuevaClave } = req.body;
  if (!token || !nuevaClave) return res.status(400).json({ message: 'Faltan datos.' });

  try {
    const result = await pool.query(
      'SELECT usuario_id FROM reset_tokens WHERE token = $1 AND expira_en > NOW()',
      [token]
    );
    if (result.rows.length === 0) return res.status(400).json({ message: 'Token inválido o expirado.' });

    const usuarioId = result.rows[0].usuario_id;
    const hashed = await bcrypt.hash(nuevaClave, saltRounds);
    await pool.query('UPDATE usuario SET clave = $1 WHERE usuario_id = $2', [hashed, usuarioId]);
    await pool.query('DELETE FROM reset_tokens WHERE token = $1', [token]);

    res.status(200).json({ message: 'Contraseña restablecida exitosamente.' });
  } catch (err) {
    console.error('Error al restablecer contraseña:', err);
    res.status(500).json({ message: 'Error al restablecer contraseña.' });
  }
});

// ===================================================================================
// RUTAS DE LA API (Requieren autenticación)
// ===================================================================================

// GET /api/dispositivos (Listar dispositivos del usuario)
app.get('/api/dispositivos', isAuth, async (req, res) => {
  try {
    // const result = await pool.query('SELECT * FROM dispositivo WHERE usuario_id = $1', [req.userId]);
    const result = await pool.query(`SELECT * FROM dispositivo 
      JOIN registro ON dispositivo.dsp_id = registro.dsp_id 
      WHERE registro.usr_id = $1`, [req.userId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener dispositivos:', err);
    res.status(500).json({ message: 'Error al obtener la lista de dispositivos.' });
  }
});

app.post('/api/dispositivo/parametros', async (req, res) => {
  console.log('🔧 Obteniendo parámetros para dispositivo ID:', req.body.dsp_id);
  try {
    const result = await pool.query(`SELECT * 
     FROM dispositivo_parametro 
      JOIN parametros ON dispositivo_parametro.prt_id = parametros.prt_id
      join registro on registro.dsp_id = dispositivo_parametro.dsp_id and registro.rgt_id = $3
      join registro_valor on registro_valor.rgt_id = registro.rgt_id and registro_valor.prt_id = parametros.prt_id
      WHERE registro.usr_id = $2 AND dispositivo_parametro.dsp_id = $1`, [req.body.dsp_id, req.body.usr_id, req.body.rgt_id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener parametros:', err);
    res.status(500).json({ message: 'Error al obtener la lista de parametros.' });
  }
});

// POST /api/dispositivo/registro (Registrar dispositivo)
app.post('/api/dispositivo/registro', async (req, res) => {
  const { tipo, seriestype, nombre, serial, userId } = req.body;
  if (!nombre || !serial || !userId || (!tipo && !seriestype)) {
    return res.status(400).json({ message: 'Datos incompletos.' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const tipoBusqueda = tipo ?? seriestype;

    const result = await pool.query('SELECT * FROM dispositivo WHERE dispositivo.seriestype = $1', [tipoBusqueda]);

    if(result.rows.length == 0){
      return res.status(409).json({ message: `El dispositivo tipo ${tipoBusqueda} no existe.` });
    }

    const dsp = result.rows[0];
    

    const insertQueryReg = `
      INSERT INTO registro (usr_id, dsp_id, topic, nombre_registrado, serial, fecha_registro)
      VALUES ($1, $2, $3, $4, $5, now()) returning rgt_id;
    `;

    const topic = `${dsp.modelo}/${dsp.abreviatura}/`+serial;

    const resultReg = await client.query(insertQueryReg, [userId, dsp.dsp_id, topic, nombre, serial]);
    
    const result1 = await pool.query(`SELECT * 
     FROM dispositivo_parametro 
      JOIN parametros ON dispositivo_parametro.prt_id = parametros.prt_id
      WHERE dispositivo_parametro.dsp_id = $1`, [dsp.dsp_id]);

    for(const row of result1.rows){
      const insertQueryVal = `
        INSERT INTO registro_valor (rgt_id, prt_id, valor)  
        VALUES ($1, $2, $3);
        `;
      const resultVal = await client.query(insertQueryVal, [resultReg.rows[0].rgt_id, row.prt_id, row.valorini]);
    }

    await client.query('COMMIT');

    const telemetryTopic = topic.concat('/out');

    mqttClient.subscribe(telemetryTopic, (err) => {
      if (!err) {
        console.log(`✅ Suscrito al topic de telemetría general: ${telemetryTopic}`);
      } else {
        console.error(`❌ Error al suscribirse a ${telemetryTopic}:`, err);
      }
    });

    res.status(201).json({
      message: 'Dispositivo registrado exitosamente en la plataforma.',
      dispositivo_id: dsp.dsp_id,
      topic: topic
    });

  } catch (error) {
    if (client) await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ message: `El dispositivo con serial ${serial} ya está registrado.` });
    }
    console.error('Error al registrar nuevo dispositivo:', error);
    res.status(500).json({ message: 'Error interno al registrar el dispositivo.' });
  } finally {
    if (client) client.release();
  }
});

app.post('/api/dispositivo/actualizar', async (req, res) => {
console.log(req.body)
  const message = JSON.stringify({
    "bomba": req.body.message,
    "valvula": req.body.message == 'apagada' ? 'abierta' : 'cerrada'
  });

  mqttClient.publish(req.body.topic.concat('/in'), message, { qos: 0, retain: false }, (err) => {
    if (!err) {
      
      console.log(`✅ Mensaje enviado al topic de telemetría general: ${req.body.topic.concat('/in')}, mensaje: ${message}`);
      res.status(201).json({
        message: 'Dispositivo actualizado exitosamente.'
      });
    } else {
      console.error(`❌ Error al publicar a ${req.body.topic.concat('/in')}:`, err);
      res.status(400).json({
        message: `❌ Error al publicar a ${req.body.topic.concat('/in')}:`
      });
    }
  });

  
});

app.post('/api/dispositivo/token', async (req, res) => {

  // await pool.query('UPDATE usuario SET frb_token = $1 WHERE correo = $2', [req.body.token, req.body.correo]); 
  await pool.query('UPDATE sesion SET frb_token = $1 WHERE token = $2', [req.body.frb_token, req.body.text]);

  res.status(201).json({
      message: 'Dispositivo actualizado exitosamente.'
  });

});

app.post('/api/dispositivo/refresh', async (req, res) => {
  
  mqttClient.publish(req.body.topic.concat('/in'), '{ "actualizar": 1 }', { qos: 0, retain: false }, (err) => {
    if (!err) {
      
      console.log(`✅ Mensaje enviado al topic de telemetría general: ${req.body.topic.concat('/in')}, mensaje: ${'{ "actualizar": 1 }'}`);
      res.status(201).json({
        message: 'Dispositivo actualizado exitosamente.'
      });
    } else {
      console.error(`❌ Error al publicar a ${req.body.topic.concat('/in')}:`, err);
      res.status(400).json({
        message: `❌ Error al publicar a ${req.body.topic.concat('/in')}:`
      });
    }
  });

  
});

// GET /api/dispositivo/horarios/activo/:serial (Obtener estado activo de horarios)
app.get('/api/dispositivo/horarios/activo/:serial', async (req, res) => {
  const { serial } = req.params;
  
  if (!serial) {
    return res.status(400).json({ 
      message: 'Serial requerido' 
    });
  }

  let client;
  try {
    client = await pool.connect();
    
    // Verificar si existe algún horario con activo = true para este serial
    const result = await client.query(
      'SELECT COUNT(*) as count FROM horarios WHERE serial = $1 AND activo = true',
      [serial]
    );
    
    const tieneHorariosActivos = parseInt(result.rows[0].count) > 0;
    
    return res.status(200).json({ 
      activo: tieneHorariosActivos
    });
  } catch (error) {
    console.error('❌ Error al verificar estado de horarios:', error);
    res.status(500).json({ 
      message: 'Error interno al verificar estado de horarios.',
      error: error.message 
    });
  } finally {
    if (client) client.release();
  }
});

// PUT /api/dispositivo/horarios/activo/:serial (Activar/Desactivar horarios para un serial)
app.put('/api/dispositivo/horarios/activo/:serial', async (req, res) => {
  const { serial } = req.params;
  const { activo } = req.body;
  
  if (!serial || activo === undefined) {
    return res.status(400).json({ 
      message: 'Serial y activo son requeridos' 
    });
  }

  let client;
  try {
    client = await pool.connect();
    
    // Actualizar todos los horarios del serial
    await client.query(
      `UPDATE horarios SET activo = $1 WHERE serial = $2`,
      [activo, serial]
    );
    
    console.log(`✅ Horarios ${activo ? 'activados' : 'desactivados'} para serial: ${serial}`);
    return res.status(200).json({ 
      message: `Horarios ${activo ? 'activados' : 'desactivados'} exitosamente.`,
      activo: activo
    });
  } catch (error) {
    console.error('❌ Error al actualizar estado de horarios:', error);
    res.status(500).json({ 
      message: 'Error interno al actualizar estado de horarios.',
      error: error.message 
    });
  } finally {
    if (client) client.release();
  }
});

// POST /api/dispositivo/horarios (Guardar horario)
app.post('/api/dispositivo/horarios', async (req, res) => {
  let { horario_id, serial, dias_semana, hora_inicio, hora_fin, activo, tz_offset } = req.body;
  
  if (!serial || !dias_semana || !hora_inicio || !hora_fin || activo === undefined) {
    return res.status(400).json({ 
      message: 'Faltan datos requeridos: serial, dias_semana, hora_inicio, hora_fin, activo' 
    });
  }

  // Si viene tz_offset, convertir horario local a UTC antes de guardar
  if (tz_offset !== undefined && tz_offset !== null) {
    const dayOrder = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
    const shiftDays = (daysArr, delta) =>
      daysArr.map(d => {
        const idx = dayOrder.indexOf(d);
        if (idx === -1) return null;
        return dayOrder[(idx + delta + 7) % 7];
      }).filter(Boolean);

    const toUtc = (timeStr, offsetMin) => {
      const [h, m] = timeStr.split(':').map(n => parseInt(n, 10));
      const total = h * 60 + m + offsetMin;
      const delta = Math.floor(total / 1440);
      const norm = ((total % 1440) + 1440) % 1440;
      const hh = String(Math.floor(norm / 60)).padStart(2, '0');
      const mm = String(norm % 60).padStart(2, '0');
      return { time: `${hh}:${mm}`, delta };
    };

    const daysArr = dias_semana.split(',').filter(Boolean);
    const startUtc = toUtc(hora_inicio, parseInt(tz_offset, 10));
    const endUtc = toUtc(hora_fin, parseInt(tz_offset, 10));
    const daySet = new Set();
    shiftDays(daysArr, startUtc.delta).forEach(d => daySet.add(d));
    if (endUtc.delta !== startUtc.delta) {
      shiftDays(daysArr, endUtc.delta).forEach(d => daySet.add(d));
    }

    dias_semana = Array.from(daySet).join(',');
    hora_inicio = startUtc.time;
    hora_fin = endUtc.time;
  }

  let client;
  try {
    client = await pool.connect();
    
    // Si activo es false, NO hacer nada (no guardar, no eliminar)
    if (activo === false) {
      return res.status(200).json({ 
        message: 'Horarios desactivados. No se guardó el horario.',
        horario_id: null
      });
    }

    // Si horario_id es null, insertar nuevo horario
    if (!horario_id) {
      const result = await client.query(
        `INSERT INTO horarios (serial, dias_semana, hora_inicio, hora_fin, activo) 
         VALUES ($1, $2, $3, $4, $5) 
         RETURNING horario_id`,
        [serial, dias_semana, hora_inicio, hora_fin, activo]
      );
      
      // Si se guarda un horario con activo = true, activar todos los horarios de este serial
      if (activo === true) {
        await client.query(
          `UPDATE horarios SET activo = true WHERE serial = $1`,
          [serial]
        );
        console.log(`✅ Todos los horarios del serial ${serial} han sido activados`);
      }
      
      console.log(`✅ Horario creado para serial: ${serial}, horario_id: ${result.rows[0].horario_id}`);
      return res.status(201).json({ 
        message: 'Horario guardado exitosamente.',
        horario_id: result.rows[0].horario_id
      });
    } else {
      // Actualizar horario existente
      await client.query(
        `UPDATE horarios 
         SET dias_semana = $1, hora_inicio = $2, hora_fin = $3, activo = $4 
         WHERE horario_id = $5 AND serial = $6`,
        [dias_semana, hora_inicio, hora_fin, activo, horario_id, serial]
      );
      
      console.log(`✅ Horario actualizado: horario_id ${horario_id} para serial: ${serial}`);
      return res.status(200).json({ 
        message: 'Horario actualizado exitosamente.',
        horario_id: horario_id
      });
    }
  } catch (error) {
    console.error('❌ Error al guardar horario:', error);
    res.status(500).json({ 
      message: 'Error interno al guardar el horario.',
      error: error.message 
    });
  } finally {
    if (client) client.release();
  }
});

// GET /api/dispositivo/horarios/activo-ahora/:serial (Horario activo actual)
app.get('/api/dispositivo/horarios/activo-ahora/:serial', async (req, res) => {
  const { serial } = req.params;

  if (!serial) {
    return res.status(400).json({
      message: 'Serial requerido'
    });
  }

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT horario_id, dias_semana, hora_inicio, hora_fin, activo
       FROM horarios
       WHERE serial = $1 AND activo = true`,
      [serial]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({ activo: false, horario: null });
    }

    const ahora = new Date();
    const diaSemanaActual = ahora.getDay(); // 0=Domingo, 1=Lunes, ..., 6=Sábado
    const horaActual = ahora.getHours();
    const minutoActual = ahora.getMinutes();
    const horaActualStr = `${horaActual.toString().padStart(2, '0')}:${minutoActual.toString().padStart(2, '0')}`;

    // Mapear días de la semana: L=1, M=2, X=3, J=4, V=5, S=6, D=0
    const diaMap = { L: 1, M: 2, X: 3, J: 4, V: 5, S: 6, D: 0 };
    const diaActualLetra = Object.keys(diaMap).find(key => diaMap[key] === diaSemanaActual);

    let horarioActivo = null;
    for (const horario of result.rows) {
      const diasSemana = (horario.dias_semana || '').split(',').filter(Boolean);
      const diaCoincide = diasSemana.includes(diaActualLetra);
      if (!diaCoincide) continue;
      const estaDentroDelHorario = horaActualStr >= horario.hora_inicio && horaActualStr < horario.hora_fin;
      if (estaDentroDelHorario) {
        horarioActivo = horario;
        break;
      }
    }

    return res.status(200).json({
      activo: Boolean(horarioActivo),
      horario: horarioActivo
        ? {
            dias_semana: horarioActivo.dias_semana,
            hora_inicio: horarioActivo.hora_inicio,
            hora_fin: horarioActivo.hora_fin
          }
        : null
    });
  } catch (error) {
    console.error('❌ Error al obtener horario activo actual:', error);
    return res.status(500).json({
      message: 'Error interno al obtener horario activo actual.',
      error: error.message
    });
  } finally {
    if (client) client.release();
  }
});

// PUT /api/dispositivo/horarios/:horario_id (Actualizar horario)
app.put('/api/dispositivo/horarios/:horario_id', async (req, res) => {
  const { horario_id } = req.params;
  let { dias_semana, hora_inicio, hora_fin, activo, tz_offset } = req.body;

  if (!horario_id || !dias_semana || !hora_inicio || !hora_fin || activo === undefined) {
    return res.status(400).json({
      message: 'Faltan datos requeridos: horario_id, dias_semana, hora_inicio, hora_fin, activo'
    });
  }

  // Si viene tz_offset, convertir horario local a UTC antes de guardar
  if (tz_offset !== undefined && tz_offset !== null) {
    const dayOrder = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
    const shiftDays = (daysArr, delta) =>
      daysArr.map(d => {
        const idx = dayOrder.indexOf(d);
        if (idx === -1) return null;
        return dayOrder[(idx + delta + 7) % 7];
      }).filter(Boolean);

    const toUtc = (timeStr, offsetMin) => {
      const [h, m] = timeStr.split(':').map(n => parseInt(n, 10));
      const total = h * 60 + m + offsetMin;
      const delta = Math.floor(total / 1440);
      const norm = ((total % 1440) + 1440) % 1440;
      const hh = String(Math.floor(norm / 60)).padStart(2, '0');
      const mm = String(norm % 60).padStart(2, '0');
      return { time: `${hh}:${mm}`, delta };
    };

    const daysArr = (dias_semana || '').split(',').filter(Boolean);
    const startUtc = toUtc(hora_inicio, parseInt(tz_offset, 10));
    const endUtc = toUtc(hora_fin, parseInt(tz_offset, 10));
    const daySet = new Set();
    shiftDays(daysArr, startUtc.delta).forEach(d => daySet.add(d));
    if (endUtc.delta !== startUtc.delta) {
      shiftDays(daysArr, endUtc.delta).forEach(d => daySet.add(d));
    }

    dias_semana = Array.from(daySet).join(',');
    hora_inicio = startUtc.time;
    hora_fin = endUtc.time;
  }

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `UPDATE horarios
       SET dias_semana = $1, hora_inicio = $2, hora_fin = $3, activo = $4
       WHERE horario_id = $5
       RETURNING horario_id`,
      [dias_semana, hora_inicio, hora_fin, activo, horario_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Horario no encontrado.' });
    }

    return res.status(200).json({
      message: 'Horario actualizado exitosamente.',
      horario_id: result.rows[0].horario_id
    });
  } catch (error) {
    console.error('❌ Error al actualizar horario:', error);
    return res.status(500).json({
      message: 'Error interno al actualizar el horario.',
      error: error.message
    });
  } finally {
    if (client) client.release();
  }
});

// GET /api/dispositivo/horarios/:serial (Listar horarios guardados)
app.get('/api/dispositivo/horarios/:serial', async (req, res) => {
  const { serial } = req.params;

  if (!serial) {
    return res.status(400).json({
      message: 'Serial requerido'
    });
  }

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT horario_id, serial, dias_semana, hora_inicio, hora_fin, activo
       FROM horarios
       WHERE serial = $1
       ORDER BY horario_id ASC`,
      [serial]
    );

    return res.status(200).json({
      horarios: result.rows
    });
  } catch (error) {
    console.error('❌ Error al obtener horarios:', error);
    return res.status(500).json({
      message: 'Error interno al obtener horarios.',
      error: error.message
    });
  } finally {
    if (client) client.release();
  }
});

// DELETE /api/dispositivo/horarios/:horario_id (Eliminar horario)
app.delete('/api/dispositivo/horarios/:horario_id', async (req, res) => {
  const { horario_id } = req.params;

  if (!horario_id) {
    return res.status(400).json({
      message: 'horario_id requerido'
    });
  }

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `DELETE FROM horarios WHERE horario_id = $1 RETURNING horario_id`,
      [horario_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Horario no encontrado.' });
    }

    return res.status(200).json({
      message: 'Horario eliminado exitosamente.',
      horario_id: result.rows[0].horario_id
    });
  } catch (error) {
    console.error('❌ Error al eliminar horario:', error);
    return res.status(500).json({
      message: 'Error interno al eliminar horario.',
      error: error.message
    });
  } finally {
    if (client) client.release();
  }
});

// PATCH /api/dispositivo/horarios/:horario_id (Actualizar activo de un horario)
app.patch('/api/dispositivo/horarios/:horario_id', async (req, res) => {
  const { horario_id } = req.params;
  const { activo } = req.body;

  if (!horario_id || activo === undefined) {
    return res.status(400).json({
      message: 'horario_id y activo son requeridos'
    });
  }

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `UPDATE horarios SET activo = $1 WHERE horario_id = $2 RETURNING horario_id, activo`,
      [activo, horario_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Horario no encontrado.' });
    }

    return res.status(200).json({
      message: 'Horario actualizado exitosamente.',
      horario_id: result.rows[0].horario_id,
      activo: result.rows[0].activo
    });
  } catch (error) {
    console.error('❌ Error al actualizar horario:', error);
    return res.status(500).json({
      message: 'Error interno al actualizar horario.',
      error: error.message
    });
  } finally {
    if (client) client.release();
  }
});

// ===================================================================================
// PROCESAMIENTO DE MENSAJES MQTT
// ===================================================================================

const procesarMensajesMqtt = () => {
  if (!mqttClient) return;
  console.log('🔧 Iniciando procesamiento de mensajes MQTT...');
  
  mqttClient.on('message', async (topic, message) => {
    console.log(`📥 Mensaje recibido en topic [${topic}]: ${message.toString()}`);
    const parts = topic.split('/');
    // if (parts.length !== 3 || parts[2] !== 'telemetria') return;
    const serie = parts[2];

    // const msg = {
    //   notification: {
    //     title: topic,
    //     body: message.toString(),
    //   },
    // };

    const msg = {
      data: {
        title: topic,
        body: message.toString(),
      },
    };

    let dbClient;
    try {
      // const data = JSON.parse(message.toString());
      // const { temp, ph, msg_id } = data;
      const timestamp = new Date();

      // if (!serie || temp === undefined || ph === undefined || !msg_id) {
      //   console.warn(`⚠️ Mensaje inválido o incompleto del topic [${topic}].`);
      //   return;
      // }

      dbClient = await pool.connect();
      await dbClient.query('BEGIN');

      // const deviceResult = await dbClient.query('SELECT frb_token FROM sesion join usuario on sesion.usuario_id = usuario.usr_id WHERE serial = $1', [serie]);
      const deviceResult = await dbClient.query('SELECT registro.rgt_id, sesion.frb_token FROM registro join sesion on registro.usr_id = sesion.usuario_id WHERE registro.serial = $1 AND sesion.frb_token IS NOT null', [serie]);
      if (deviceResult.rows.length === 0) {
        await dbClient.query('ROLLBACK');
        return;
      }
      const rgt_id = deviceResult.rows[0].rgt_id;
      // const frb_token = deviceResult.rows[0].frb_token;

      // const telemetryInsert = `
      //   INSERT INTO mensajes (rgt_id, data, status)
      //   VALUES ($1, $2, 1);
      // `;
      // await dbClient.query(telemetryInsert, [rgt_id, message]);

      const updateDevice = `
        UPDATE registro
        SET 
          ultima_conexion = now(), 
          estatus = 'A'
        WHERE rgt_id = $1;
      `;
      // await dbClient.query(updateDevice, [rgt_id]);

      console.log(JSON.parse(message.toString().replace(/'/g, '"')));
      const messageJ = JSON.parse(message.toString().replace(/'/g, '"'));

      const result1 = await pool.query(`SELECT vlr_id, tipo, parametros.prt_id
        FROM registro_valor 
        JOIN parametros ON registro_valor.prt_id = parametros.prt_id
        WHERE registro_valor.rgt_id = $1`, [rgt_id]); 

      for(const row of result1.rows){
        if(messageJ[row.tipo] === undefined) continue;
        console.log(`🔧 Actualizando valor [${row.tipo}] para rgt_id ${rgt_id} prt_id ${row.prt_id } con valor ${messageJ[row.tipo]}`);
        const insertQueryVal = `
          UPDATE registro_valor SET valor = $3 WHERE rgt_id = $1 AND prt_id = $2;`;
        const resultVal = await dbClient.query(insertQueryVal, [rgt_id, row.prt_id, messageJ[row.tipo]]);
      }

      await dbClient.query('COMMIT');

      for (const row of deviceResult.rows){
        console.log('🔧 Enviando notificación a token:', row.frb_token);
        admin.messaging().send({...msg, token: row.frb_token
          })
          .then((response) => {
              console.log('✅ Notificación enviada exitosamente:', response);
          })
          .catch(async (error) => {
              // Si el token no está registrado o es inválido, limpiarlo de la base de datos
              if (error.code === 'messaging/registration-token-not-registered' || 
                  error.code === 'messaging/invalid-registration-token' ||
                  error.code === 'messaging/invalid-argument') {
                console.warn(`⚠️ Token inválido detectado, limpiando de la base de datos: ${row.frb_token.substring(0, 20)}...`);
                try {
                  await pool.query('UPDATE sesion SET frb_token = NULL WHERE frb_token = $1', [row.frb_token]);
                  console.log('✅ Token inválido eliminado de la base de datos');
                } catch (dbError) {
                  console.error('❌ Error al limpiar token inválido:', dbError);
                }
              } else {
                console.error('❌ Error enviando notificación:', error.code, error.message);
              }
          });   

      }



    } catch (error) {
      if (dbClient) await dbClient.query('ROLLBACK');
      console.error(`❌ Error procesando mensaje del topic [${topic}]:`, error.message);
    } finally {
      if (dbClient) dbClient.release();
    }
  });

  mqttClient.on('error', (error) => {
    console.error('❌ Error en la conexión MQTT:', error);
  });
};

// ===================================================================================
// MARCAR DISPOSITIVOS OFFLINE (solo si existe la columna ultima_conexion)
// ===================================================================================

const marcarOfflineSiNoReportan = async () => {
  try {
    // Verificar si existe la columna ultima_conexion
    const columnCheck = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'registro' AND column_name = 'ultima_conexion'
    `);

    if (columnCheck.rows.length === 0) {
      console.warn('⚠️ Columna ultima_conexion no encontrada en tabla dispositivo. Saltando marcado offline.');
      return;
    }

    await pool.query(`
      UPDATE registro
      SET estatus = 'O'
      WHERE estatus = 'online' AND ultima_conexion < NOW() - INTERVAL '5 minutes'
    `);
  } catch (err) {
    console.error('❌ Error al marcar dispositivos offline:', err);
  }
};

setInterval(marcarOfflineSiNoReportan, 60000); // Cada 60 segundos

// ===================================================================================
// EJECUCIÓN DE HORARIOS
// ===================================================================================

const ejecutarHorarios = async () => {
  if (!mqttClient) return;
  
  let client;
  try {
    client = await pool.connect();
    
    // Obtener todos los horarios activos (activo = true)
    const horariosResult = await client.query(
      `SELECT h.*, r.topic 
       FROM horarios h
       JOIN registro r ON h.serial = r.serial
       WHERE h.activo = true`
    );
    
    if (horariosResult.rows.length === 0) {
      // No hay horarios activos, no hacer nada (activo = false)
      return;
    }
    
    // Si hay horarios activos, ejecutar la lógica
    const ahora = new Date();
    // Comparar en UTC (horarios guardados en UTC)
    const diaSemanaActual = ahora.getUTCDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
    const horaActual = ahora.getUTCHours();
    const minutoActual = ahora.getUTCMinutes();
    const horaActualStr = `${horaActual.toString().padStart(2, '0')}:${minutoActual.toString().padStart(2, '0')}`;
    
    // Mapear días de la semana: L=1, M=2, X=3, J=4, V=5, S=6, D=0
    const diaMap = { 'L': 1, 'M': 2, 'X': 3, 'J': 4, 'V': 5, 'S': 6, 'D': 0 };
    
    // Agrupar horarios por serial para evitar conflictos
    const horariosPorSerial = {};
    for (const horario of horariosResult.rows) {
      if (!horariosPorSerial[horario.serial]) {
        horariosPorSerial[horario.serial] = [];
      }
      horariosPorSerial[horario.serial].push(horario);
    }
    
    for (const serial in horariosPorSerial) {
      const horarios = horariosPorSerial[serial];
      const topic = horarios[0].topic;
      const topicIn = topic.concat('/in');

      // Enviar solo al inicio y al fin exactos
      for (const horario of horarios) {
        const diasSemana = horario.dias_semana.split(',');
        const horaInicio = (horario.hora_inicio || '').toString().slice(0, 5);
        const horaFin = (horario.hora_fin || '').toString().slice(0, 5);

        // Verificar si el día actual está en los días programados
        const diaActualLetra = Object.keys(diaMap).find(key => diaMap[key] === diaSemanaActual);
        const diaCoincide = diasSemana.includes(diaActualLetra);
        console.log(
          `🕒 [HORARIOS] Comparando serial=${serial} dia=${diaActualLetra} dias=${diasSemana.join(',')} horaActual=${horaActualStr} inicio=${horaInicio} fin=${horaFin} coincideDia=${diaCoincide}`
        );
        if (!diaCoincide) continue;

        if (horaActualStr === horaInicio) {
          const messageInicio = JSON.stringify({
            "bomba": "encendida",
            "valvula": "cerrada"
          });
          console.log(`📤 [HORARIOS] Enviando a MQTT ${topicIn}: ${messageInicio}`);
          mqttClient.publish(topicIn, messageInicio, { qos: 1, retain: false }, (err) => {
            if (!err) {
              console.log(`✅ [HORARIOS] Dispositivo ${serial} inicio horario (${horaInicio})`);
            } else {
              console.error(`❌ [HORARIOS] Error al enviar inicio de horario a ${serial}:`, err);
            }
          });
        }

        if (horaActualStr === horaFin) {
          const messageFin = JSON.stringify({
            "bomba": "apagada",
            "valvula": "abierta"
          });
          console.log(`📤 [HORARIOS] Enviando a MQTT ${topicIn}: ${messageFin}`);
          mqttClient.publish(topicIn, messageFin, { qos: 1, retain: false }, (err) => {
            if (!err) {
              console.log(`✅ [HORARIOS] Dispositivo ${serial} fin horario (${horaFin})`);
            } else {
              console.error(`❌ [HORARIOS] Error al enviar fin de horario a ${serial}:`, err);
            }
          });
        }
      }
    }
  } catch (error) {
    console.error('❌ Error al ejecutar horarios:', error);
  } finally {
    if (client) client.release();
  }
};

// Ejecutar horarios cada minuto
let horariosInterval = null;
const iniciarEjecucionHorarios = () => {
  try {
    console.log('🔄 Iniciando sistema de ejecución de horarios...');
    
    if (horariosInterval) {
      clearInterval(horariosInterval);
    }
    
    // Ejecutar inmediatamente al iniciar (sin await para no bloquear)
    ejecutarHorarios().catch(err => {
      console.error('❌ Error en ejecución inicial de horarios:', err);
    });
    
    // Ejecutar cada minuto (60000 ms)
    horariosInterval = setInterval(() => {
      ejecutarHorarios().catch(err => {
        console.error('❌ Error en ejecución periódica de horarios:', err);
      });
    }, 60000);
    
    console.log('✅ Sistema de ejecución de horarios iniciado (verificación cada minuto)');
  } catch (error) {
    console.error('❌ Error al iniciar ejecución de horarios:', error);
    console.error('Stack trace:', error.stack);
  }
};

// ===================================================================================
// RUTAS ADICIONALES Y SERVIDOR DE ARCHIVOS ESTÁTICOS (FRONTEND)
// ===================================================================================

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/', async (req, res) => {
  const token = req.cookies.session_token;
  if (!token) return res.sendFile(path.join(__dirname, 'www', 'login.html'));

  try {
    const result = await pool.query(
      'SELECT 1 FROM sesion WHERE token = $1 AND expira_en > NOW()',
      [token]
    );
    if (result.rows.length === 0) {
      res.clearCookie('session_token');
      return res.sendFile(path.join(__dirname, 'www', 'login.html'));
    }
    res.sendFile(path.join(__dirname, 'www', 'app.html'));
  } catch (err) {
    console.error('Error al validar cookie:', err);
    res.clearCookie('session_token');
    res.sendFile(path.join(__dirname, 'www', 'login.html'));
  }
});

app.use(express.static(path.join(__dirname, 'www')));

// ===================================================================================
// INICIAR EL SERVIDOR EXPRESS
// ===================================================================================
const PORT = process.env.PORT || 8081;

const initializeApplicationServices = async () => {
  console.log('🔄 [DEBUG] initializeApplicationServices iniciado...');
  try {
    console.log('🔄 [DEBUG] Conectando MQTT...');
    await connectMqtt();
    console.log('🔄 [DEBUG] Probando conexión a BD...');
    const dbConnected = await testDatabaseConnection();
    if (!dbConnected) {
      console.error('❌ No se pudo conectar a la base de datos. Las funciones de autenticación y DB fallarán.');
    } else {
      try {
        console.log('🔄 [DEBUG] Iniciando procesarMensajesMqtt...');
        procesarMensajesMqtt();
        console.log('🔄 [DEBUG] Llamando a iniciarEjecucionHorarios...');
        iniciarEjecucionHorarios(); // Iniciar ejecución de horarios
        console.log('🔄 [DEBUG] iniciarEjecucionHorarios llamado exitosamente');
      } catch (error) {
        console.error('❌ Error iniciando servicios MQTT/Horarios:', error);
        console.error('Stack trace:', error.stack);
      }
    }
  } catch (error) {
    console.error('❌ Error en initializeApplicationServices:', error);
    console.error('Stack trace:', error.stack);
  }
};

const startServer = () => {
  console.log('🚀 Iniciando servidor Express...');
  const host = isProduction ? '0.0.0.0' : 'localhost';

  app.listen(PORT, host, () => {
    console.log(`✅ Servidor Express ejecutándosee en ${host}:${PORT}`);
  });
};

initializeApplicationServices();
startServer();
