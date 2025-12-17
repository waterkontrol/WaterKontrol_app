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

const connectMqtt = () => {
  const url = process.env.MQTT_BROKER_URL || 'mqtt://test.mosquitto.org';
  mqttClient = mqtt.connect(url);

  mqttClient.on('connect', () => {
    console.log('✅ Conexión a MQTT Broker exitosa.');
    const telemetryTopic = 'mk-208/VB/E8:6B:EA:DE:ED:74';
    mqttClient.subscribe(telemetryTopic, (err) => {
      if (!err) {
        console.log(`✅ Suscrito al topic de telemetría general: ${telemetryTopic}`);
      } else {
        console.error(`❌ Error al suscribirse a ${telemetryTopic}:`, err);
      }
    });
  });
  return mqttClient;
};

connectMqtt();

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
      join registro on registro.dsp_id = dispositivo_parametro.dsp_id
      join registro_valor on registro_valor.rgt_id = registro.rgt_id and registro_valor.prt_id = parametros.prt_id
      WHERE registro.usr_id = $2 AND dispositivo_parametro.dsp_id = $1`, [req.body.dsp_id, req.body.usr_id]);
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
  res.status(201).json({
      message: 'Dispositivo actualizado exitosamente.'
    });
});

app.post('/api/dispositivo/token', async (req, res) => {

  await pool.query('UPDATE usuario SET frb_token = $1 WHERE correo = $2', [req.body.token, req.body.correo]); 

  res.status(201).json({
      message: 'Dispositivo actualizado exitosamente.'
  });

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

    const msg = {
      notification: {
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

      const deviceResult = await dbClient.query('SELECT rgt_id, frb_token FROM registro join usuario on registro.usr_id = usuario.usr_id WHERE serial = $1', [serie]);
      if (deviceResult.rows.length === 0) {
        await dbClient.query('ROLLBACK');
        return;
      }
      const rgt_id = deviceResult.rows[0].rgt_id;
      const frb_token = deviceResult.rows[0].frb_token;

      const telemetryInsert = `
        INSERT INTO mensajes (rgt_id, data, status)
        VALUES ($1, $2, 1);
      `;
      await dbClient.query(telemetryInsert, [rgt_id, message]);

      const updateDevice = `
        UPDATE registro
        SET 
          ultima_conexion = $1, 
          estatus = 'A'
        WHERE rgt_id = $2;
      `;
      await dbClient.query(updateDevice, [timestamp, rgt_id]);

      console.log(JSON.parse(message.toString().replace(/'/g, '"')));
      const messageJ = JSON.parse(message.toString().replace(/'/g, '"'));

      const result1 = await pool.query(`SELECT vlr_id, tipo
        FROM registro_valor 
        JOIN parametros ON registro_valor.prt_id = parametros.prt_id
        WHERE registro_valor.rgt_id = $1`, [rgt_id]); 

      for(const row of result1.rows){
        console.log(`🔧 Actualizando valor [${row.tipo}] para rgt_id ${rgt_id} prt_id ${row.prt_id } con valor ${messageJ[row.tipo]}`);
        const insertQueryVal = `
          UPDATE registro_valor SET valor = $3 WHERE rgt_id = $1 AND prt_id = $2;`;
        const resultVal = await dbClient.query(insertQueryVal, [rgt_id, row.prt_id, messageJ[row.tipo]]);
      }

      await dbClient.query('COMMIT');

      admin.messaging().send({...msg, token: frb_token})
        .then((response) => {
            console.log('Successfully sent message:', response);
        })
        .catch((error) => {
            console.log('Error sending message:', error);
        }); 

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
  const dbConnected = await testDatabaseConnection();
  if (!dbConnected) {
    console.error('❌ No se pudo conectar a la base de datos. Las funciones de autenticación y DB fallarán.');
  } else {
    try {
      procesarMensajesMqtt();
    } catch (error) {
      console.error('❌ Error iniciando MQTT:', error);
    }
  }
};

const startServer = () => {
  console.log('🚀 Iniciando servidor Express...');
  const host = isProduction ? '0.0.0.0' : 'localhost';

  app.listen(PORT, host, () => {
    console.log(`✅ Servidor Express ejecutándose en ${host}:${PORT}`);
  });
};

initializeApplicationServices();
startServer();