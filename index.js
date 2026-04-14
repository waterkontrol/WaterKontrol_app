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
const { Resend } = require('resend');
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

const isAdmin = async (req, res, next) => {
  try {
    const result = await pool.query('SELECT role FROM usuario WHERE usr_id = $1', [req.userId]);
    if (result.rows.length === 0 || result.rows[0].role !== 'admin') {
      return res.status(403).json({ message: 'Acceso denegado. Se requiere rol de administrador.' });
    }
    next();
  } catch (err) {
    console.error('Error al verificar rol:', err);
    res.status(500).json({ message: 'Error interno del servidor.' });
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

const resend = new Resend(process.env.RESEND_API_KEY || '');
const EMAIL_FROM = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'no-reply@waterkontrol.app';
const RESEND_FROM = process.env.RESEND_FROM || EMAIL_FROM;
const APP_URL_SCHEME = process.env.APP_URL_SCHEME || 'io.ionic.starter';

const sendPasswordResetEmail = async (correo, resetLink, fallbackLink = null) => {
  const subject = 'Restablece tu contraseña - Kontrol';
  const html = `
    <p>Haz clic en el siguiente enlace para restablecer tu contraseña en la app:</p>
    <p><a href="${resetLink}">Abrir Kontrol</a></p>
    ${fallbackLink ? `<p>Si tu dispositivo no abre la app, usa este enlace alternativo:</p><p><a href="${fallbackLink}">${fallbackLink}</a></p>` : ''}
  `;

  if (process.env.RESEND_API_KEY) {
    return resend.emails.send({
      from: RESEND_FROM,
      to: correo,
      subject,
      html
    });
  }

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    throw new Error('Email credentials not configured');
  }

  return transporter.sendMail({
    from: EMAIL_FROM,
    to: correo,
    subject,
    html
  });
};

let usuarioColumnsCache = null;
const loadUsuarioColumns = async () => {
  if (usuarioColumnsCache) return usuarioColumnsCache;
  const result = await pool.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_name = 'usuario' AND column_name IN ('token_verificacion', 'estatus', 'role')`
  );
  const columns = new Map(result.rows.map(r => [r.column_name, r.data_type]));
  usuarioColumnsCache = {
    hasTokenVerificacion: columns.has('token_verificacion'),
    hasEstatus: columns.has('estatus'),
    estatusType: columns.get('estatus') || null,
    hasRole: columns.has('role')
  };
  return usuarioColumnsCache;
};

const getEstatusPendienteValue = (estatusType) => {
  if (!estatusType) return 'PENDIENTE';
  const numericTypes = new Set(['smallint', 'integer', 'bigint', 'numeric']);
  return numericTypes.has(estatusType) ? 0 : 'PENDIENTE';
};

const getEstatusActivoValue = (estatusType) => {
  if (!estatusType) return 'ACTIVO';
  const numericTypes = new Set(['smallint', 'integer', 'bigint', 'numeric']);
  return numericTypes.has(estatusType) ? 1 : 'ACTIVO';
};

const isEstatusActivo = (value, estatusType) => {
  if (!estatusType) return value === 'ACTIVO';
  const numericTypes = new Set(['smallint', 'integer', 'bigint', 'numeric']);
  return numericTypes.has(estatusType) ? Number(value) === 1 : value === 'ACTIVO';
};

const generateVerificationCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const sendVerificationCodeEmail = async (correo, code) => {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) {
    throw new Error('RESEND_API_KEY o RESEND_FROM no configurado.');
  }
  await resend.emails.send({
    from: RESEND_FROM,
    to: correo,
    subject: 'Código de verificación - Kontrol',
    text: `Tu código de verificación es: ${code}`,
    html: `<p>Tu código de verificación es:</p><p><strong>${code}</strong></p>`
  });
};

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
    const columns = await loadUsuarioColumns();
    const verificationCode = generateVerificationCode();

    if (columns.hasTokenVerificacion && columns.hasEstatus) {
      const estatusPendiente = getEstatusPendienteValue(columns.estatusType);
      await pool.query(
        'INSERT INTO usuario (nombre, correo, clave, token_verificacion, estatus) VALUES ($1, $2, $3, $4, $5) RETURNING usr_id',
        [nombre, correo, hashed, verificationCode, estatusPendiente]
      );
    } else {
      await pool.query(
        'INSERT INTO usuario (nombre, correo, clave) VALUES ($1, $2, $3) RETURNING usr_id',
        [nombre, correo, hashed]
      );
    }

    await sendVerificationCodeEmail(correo, verificationCode);
    res.status(201).json({ message: 'Usuario registrado. Código de verificación enviado.' });
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
    const columns = await loadUsuarioColumns();
    let selectFields = columns.hasEstatus ? 'usr_id, clave, estatus' : 'usr_id, clave';
    if (columns.hasRole) selectFields += ', role';
    const result = await pool.query(`SELECT ${selectFields} FROM usuario WHERE correo = $1`, [correo]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Credenciales incorrectas.' });
    }

    const user = result.rows[0];
    if (columns.hasEstatus && user.estatus && !isEstatusActivo(user.estatus, columns.estatusType)) {
      return res.status(403).json({ message: 'Cuenta pendiente de verificación.' });
    }
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

    const loginResponse = { message: 'Inicio de sesión exitoso.', token: token, usr_id: user.usr_id };
    if (columns.hasRole) loginResponse.role = user.role || 'user';
    res.status(200).json(loginResponse);
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

// POST /auth/verify-code
app.post('/auth/verify-code', async (req, res) => {
  const { correo, codigo } = req.body;
  if (!correo || !codigo) {
    return res.status(400).json({ message: 'Faltan datos.' });
  }

  try {
    const columns = await loadUsuarioColumns();
    if (!columns.hasTokenVerificacion || !columns.hasEstatus) {
      return res.status(400).json({ message: 'Verificación no disponible en esta base de datos.' });
    }

    const estatusActivo = getEstatusActivoValue(columns.estatusType);
    const result = await pool.query(
      'UPDATE usuario SET estatus = $1, token_verificacion = NULL WHERE correo = $2 AND token_verificacion = $3 RETURNING usr_id',
      [estatusActivo, correo, codigo]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: 'Código inválido o ya usado.' });
    }

    return res.status(200).json({ message: 'Cuenta verificada correctamente.' });
  } catch (error) {
    console.error('Error al verificar código:', error);
    return res.status(500).json({ message: 'Error interno al verificar código.' });
  }
});

// POST /auth/resend-code
app.post('/auth/resend-code', async (req, res) => {
  const { correo } = req.body;
  if (!correo) {
    return res.status(400).json({ message: 'Falta el correo.' });
  }

  try {
    const columns = await loadUsuarioColumns();
    if (!columns.hasTokenVerificacion || !columns.hasEstatus) {
      return res.status(400).json({ message: 'Reenvío no disponible en esta base de datos.' });
    }

    const user = await pool.query(
      'SELECT usr_id, estatus FROM usuario WHERE correo = $1',
      [correo]
    );
    if (user.rows.length === 0) {
      return res.status(200).json({ message: 'Si el correo existe, se enviará el código.' });
    }
    if (isEstatusActivo(user.rows[0].estatus, columns.estatusType)) {
      return res.status(400).json({ message: 'La cuenta ya está verificada.' });
    }

    const verificationCode = generateVerificationCode();
    await pool.query(
      'UPDATE usuario SET token_verificacion = $1 WHERE correo = $2',
      [verificationCode, correo]
    );
    await sendVerificationCodeEmail(correo, verificationCode);

    return res.status(200).json({ message: 'Código reenviado.' });
  } catch (error) {
    console.error('Error al reenviar código:', error);
    return res.status(500).json({ message: 'Error interno al reenviar código.' });
  }
});

// POST /auth/forgot
app.post('/auth/forgot', async (req, res) => {
  const { correo } = req.body;
  if (!correo) return res.status(400).json({ message: 'Falta el correo.' });

  try {
    const user = await pool.query('SELECT usr_id FROM usuario WHERE correo = $1', [correo]);
    if (user.rows.length === 0) return res.status(200).json({ message: 'Si el correo existe, se enviará el enlace.' });

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO reset_tokens (token, usr_id, expira_en) VALUES ($1, $2, NOW() + INTERVAL \'1 hour\')',
      [token, user.rows[0].usr_id]
    );

    const appResetLink = `${APP_URL_SCHEME}://reset?token=${token}`;
    const webResetLink = `${RAILWAY_API_URL}/reset.html?token=${token}`;
    await sendPasswordResetEmail(correo, appResetLink, webResetLink);

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
      'SELECT usr_id FROM reset_tokens WHERE token = $1 AND expira_en > NOW()',
      [token]
    );
    if (result.rows.length === 0) return res.status(400).json({ message: 'Token inválido o expirado.' });

    const usuarioId = result.rows[0].usr_id;
    const hashed = await bcrypt.hash(nuevaClave, saltRounds);
    await pool.query('UPDATE usuario SET clave = $1 WHERE usr_id = $2', [hashed, usuarioId]);
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

// ===================================================================================
// RUTAS ADMIN - USUARIOS
// ===================================================================================

// GET /api/admin/usuarios (Listar todos los usuarios)
app.get('/api/admin/usuarios', isAuth, isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT usr_id, nombre, correo, estatus, role, pago, pago_expira
       FROM usuario ORDER BY usr_id ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener usuarios:', err);
    res.status(500).json({ message: 'Error al obtener la lista de usuarios.' });
  }
});

// PUT /api/admin/usuarios/:id/pago (Actualizar estado de pago)
app.put('/api/admin/usuarios/:id/pago', isAuth, isAdmin, async (req, res) => {
  const { id } = req.params;
  const { pago } = req.body;
  const estadosValidos = ['pago', 'por_vencer', 'no_pago'];
  if (!estadosValidos.includes(pago)) {
    return res.status(400).json({ message: 'Estado de pago inválido.' });
  }
  try {
    const pagoExpira = pago === 'pago' ? "NOW() + INTERVAL '1 month'" : 'NULL';
    const result = await pool.query(
      `UPDATE usuario SET pago = $1, pago_expira = ${pagoExpira} WHERE usr_id = $2
       RETURNING usr_id, nombre, correo, estatus, role, pago, pago_expira`,
      [pago, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error al actualizar pago:', err);
    res.status(500).json({ message: 'Error al actualizar estado de pago.' });
  }
});

// GET /api/admin/dispositivos (Listar todos los dispositivos - solo admin)
app.get('/api/admin/dispositivos', isAuth, isAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM dispositivo ORDER BY fecha_creacion DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener dispositivos (admin):', err);
    res.status(500).json({ message: 'Error al obtener la lista de dispositivos.' });
  }
});

// ===================================================================================
// RUTAS ADMIN - SERIES TYPES
// ===================================================================================

// GET /api/admin/series-types (Listar todos los series types)
app.get('/api/admin/series-types', isAuth, isAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM series_type ORDER BY numero ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener series types:', err);
    res.status(500).json({ message: 'Error al obtener series types.' });
  }
});

// POST /api/admin/series-types (Crear un series type)
app.post('/api/admin/series-types', isAuth, isAdmin, async (req, res) => {
  const { numero, variables } = req.body;
  if (numero == null || !Array.isArray(variables)) {
    return res.status(400).json({ message: 'Se requiere numero y variables.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO series_type (numero, variables) VALUES ($1, $2) RETURNING *',
      [numero, JSON.stringify(variables)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Ya existe un series type con ese número.' });
    }
    console.error('Error al crear series type:', err);
    res.status(500).json({ message: 'Error al crear series type.' });
  }
});

// PUT /api/admin/series-types/:id (Actualizar un series type)
app.put('/api/admin/series-types/:id', isAuth, isAdmin, async (req, res) => {
  const { id } = req.params;
  const { numero, variables } = req.body;
  if (numero == null || !Array.isArray(variables)) {
    return res.status(400).json({ message: 'Se requiere numero y variables.' });
  }
  try {
    const result = await pool.query(
      'UPDATE series_type SET numero = $1, variables = $2 WHERE st_id = $3 RETURNING *',
      [numero, JSON.stringify(variables), id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Series type no encontrado.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Ya existe un series type con ese número.' });
    }
    console.error('Error al actualizar series type:', err);
    res.status(500).json({ message: 'Error al actualizar series type.' });
  }
});

// DELETE /api/admin/series-types/:id (Eliminar un series type)
app.delete('/api/admin/series-types/:id', isAuth, isAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM series_type WHERE st_id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Series type no encontrado.' });
    }
    res.json({ message: 'Series type eliminado.' });
  } catch (err) {
    console.error('Error al eliminar series type:', err);
    res.status(500).json({ message: 'Error al eliminar series type.' });
  }
});

// GET /api/series-type/:numero (Obtener variables de un series type por número)
app.get('/api/series-type/:numero', isAuth, async (req, res) => {
  const { numero } = req.params;
  try {
    const result = await pool.query('SELECT * FROM series_type WHERE numero = $1', [numero]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Series type no encontrado.', variables: [] });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error al obtener series type:', err);
    res.status(500).json({ message: 'Error al obtener series type.' });
  }
});

// PUT /api/dispositivo/nombre (Actualizar nombre del dispositivo)
app.put('/api/dispositivo/nombre', isAuth, async (req, res) => {
  const { serial, nombre } = req.body || {};

  if (!serial || !nombre) {
    return res.status(400).json({ message: 'Serial y nombre son requeridos.' });
  }

  try {
    const result = await pool.query(
      `UPDATE registro
       SET nombre_registrado = $1
       WHERE serial = $2 AND usr_id = $3`,
      [nombre, serial, req.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Dispositivo no encontrado.' });
    }

    return res.status(200).json({ message: 'Nombre actualizado exitosamente.' });
  } catch (err) {
    console.error('Error al actualizar nombre del dispositivo:', err);
    return res.status(500).json({ message: 'Error al actualizar el nombre del dispositivo.' });
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

app.post('/api/dispositivo/modo', async (req, res) => {
  const { topic, modo } = req.body || {};
  if (!topic || !modo) {
    return res.status(400).json({ message: 'Faltan datos (topic, modo).' });
  }

  const payload = {
    modo_automatico: modo === 'automatico',
    modo_ingreso: modo === 'ingreso',
    modo_nivel: modo === 'nivel'
  };

  const message = JSON.stringify(payload);
  mqttClient.publish(topic.concat('/in'), message, { qos: 0, retain: false }, (err) => {
    if (!err) {
      console.log(`✅ Modo enviado a MQTT ${topic.concat('/in')}: ${message}`);
      res.status(201).json({ message: 'Modo enviado correctamente.' });
    } else {
      console.error(`❌ Error al publicar modo a ${topic.concat('/in')}:`, err);
      res.status(400).json({ message: 'Error al publicar modo.' });
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
  let { horario_id, serial, dias_semana, hora_inicio, hora_fin, activo, tz_offset, mode } = req.body;
  
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

    const modoAutomatico = mode === 'automatico';
    const modoIngreso = mode === 'ingreso';
    const modoNivel = mode === 'nivel';
    
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

      // Actualizar modo en todos los horarios del serial
      await client.query(
        `UPDATE horarios 
         SET modo_automatico = $1, modo_ingreso = $2, modo_nivel = $3
         WHERE serial = $4`,
        [modoAutomatico, modoIngreso, modoNivel, serial]
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
         SET dias_semana = $1, hora_inicio = $2, hora_fin = $3, activo = $4,
             modo_automatico = $5, modo_ingreso = $6, modo_nivel = $7
         WHERE horario_id = $8 AND serial = $9`,
        [dias_semana, hora_inicio, hora_fin, activo, modoAutomatico, modoIngreso, modoNivel, horario_id, serial]
      );

      // Asegurar que todos los horarios del serial reflejen el modo seleccionado
      await client.query(
        `UPDATE horarios 
         SET modo_automatico = $1, modo_ingreso = $2, modo_nivel = $3
         WHERE serial = $4`,
        [modoAutomatico, modoIngreso, modoNivel, serial]
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
  let { dias_semana, hora_inicio, hora_fin, activo, tz_offset, mode } = req.body;

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
    const resultSerial = await client.query(
      `SELECT serial FROM horarios WHERE horario_id = $1`,
      [horario_id]
    );
    const serial = resultSerial.rows[0]?.serial;
    const modoAutomatico = mode === 'automatico';
    const modoIngreso = mode === 'ingreso';
    const modoNivel = mode === 'nivel';
    const result = await client.query(
      `UPDATE horarios
       SET dias_semana = $1, hora_inicio = $2, hora_fin = $3, activo = $4,
           modo_automatico = $5, modo_ingreso = $6, modo_nivel = $7
       WHERE horario_id = $8
       RETURNING horario_id`,
      [dias_semana, hora_inicio, hora_fin, activo, modoAutomatico, modoIngreso, modoNivel, horario_id]
    );

    if (serial) {
      await client.query(
        `UPDATE horarios 
         SET modo_automatico = $1, modo_ingreso = $2, modo_nivel = $3
         WHERE serial = $4`,
        [modoAutomatico, modoIngreso, modoNivel, serial]
      );
    }

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

      // Activar/Desactivar horarios según ingreso de agua (serial tomado del topic)
      if (messageJ.ingreso === 'si' || messageJ.ingreso === 'no') {
        const activo = messageJ.ingreso === 'no';
        await dbClient.query(
          `UPDATE horarios SET activo = $1 WHERE serial = $2`,
          [activo, serie]
        );
        console.log(`🗓️ Horarios ${activo ? 'activados' : 'desactivados'} para serial ${serie} por ingreso=${messageJ.ingreso}`);
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
            "valvula": "cerrada",
            "tipo": "horario",
            "h_inicio": true,
            "h_fin": false
          });
          console.log(`📤 [HORARIOS] Enviando inicio ${serial} -> ${messageInicio}`);
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
            "valvula": "abierta",
            "tipo": "horario",
            "h_inicio": false,
            "h_fin": true
          });
          console.log(`📤 [HORARIOS] Enviando fin ${serial} -> ${messageFin}`);
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
let horariosTimeout = null;
const iniciarEjecucionHorarios = () => {
  try {
    console.log('🔄 Iniciando sistema de ejecución de horarios...');
    
    if (horariosInterval) {
      clearInterval(horariosInterval);
    }
    if (horariosTimeout) {
      clearTimeout(horariosTimeout);
    }
    
    // Ejecutar inmediatamente al iniciar (sin await para no bloquear)
    ejecutarHorarios().catch(err => {
      console.error('❌ Error en ejecución inicial de horarios:', err);
    });
    
    // Alinear ejecución al inicio del minuto para evitar desfases (ej. 20s)
    const now = new Date();
    const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    horariosTimeout = setTimeout(() => {
      ejecutarHorarios().catch(err => {
        console.error('❌ Error en ejecución periódica (alineada) de horarios:', err);
      });
      horariosInterval = setInterval(() => {
        ejecutarHorarios().catch(err => {
          console.error('❌ Error en ejecución periódica (alineada) de horarios:', err);
        });
      }, 60000);
    }, Math.max(0, msToNextMinute));
    
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
        await pool.query(`
          CREATE TABLE IF NOT EXISTS series_type (
            st_id SERIAL PRIMARY KEY,
            numero INTEGER UNIQUE NOT NULL,
            variables JSONB DEFAULT '[]'
          )
        `);
        console.log('✅ Tabla series_type verificada/creada');
        await pool.query(`
          ALTER TABLE usuario ADD COLUMN IF NOT EXISTS pago_expira TIMESTAMPTZ
        `);
        console.log('✅ Columna pago_expira verificada/creada');
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
