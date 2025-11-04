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
const saltRounds = 10; 

// --- CONFIGURACIÓN DE EXPRESS ---
const app = express();
app.use(express.json()); 
app.use(express.urlencoded({ extended: true })); 

// ===================================================================================
// LÓGICA DE CONEXIÓN A LA BASE DE DATOS Y BCRYPT
// ===================================================================================
console.log('🔧 Intentando conectar a la base de datos...');
// Detecta si es un entorno de producción (Railway)
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT; 
console.log('📋 DATABASE_URL:', process.env.DATABASE_URL ? '✅ Definida' : '❌ NO DEFINIDA');
console.log(`📋 Entorno: ${isProduction ? 'Producción (SSL ON)' : 'Local (SSL OFF)'}`);

const poolConfig = {
  connectionString: process.env.DATABASE_URL, 
  // CRÍTICO: Configuración SSL para Railway
  ssl: isProduction ? { rejectUnauthorized: false } : false, 
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10
};

const pool = new Pool(poolConfig);

// Verificar conexión a la base de datos al inicio
const testDatabaseConnection = async () => {
  let client;
  try {
    client = await pool.connect();
    console.log('✅ Conexión a la base de datos establecida correctamente');
    
    // Verificar las columnas críticas para la autenticación
    await client.query('SELECT correo, clave, token_verificacion, estatus FROM usuario LIMIT 1');
    console.log(`✅ Tabla "usuario" verificada. Usando campos: correo, clave, token_verificacion, estatus.`);

    return true;
  } catch (error) {
    console.error('❌ Error crítico conectando a la base de datos o faltando columnas:', error.message);
    return false;
  } finally {
    if (client) {
      client.release();
    }
  }
};

// ===================================================================================
// CONFIGURACIÓN DE NODEMAILER (CRÍTICO: CAMBIO A PUERTO 465 SSL/TLS)
// Este es el método más robusto para entornos Cloud como Railway
// ===================================================================================
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,             // CRÍTICO: Usamos puerto 465
    secure: true,          // CRÍTICO: secure: true para el puerto 465 (SSL/TLS nativo)
    auth: {
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS
    },
    tls: {
        // Mantenemos rejectUnauthorized para compatibilidad con entornos restrictivos
        rejectUnauthorized: false
    },
    // CRÍTICO: Reducimos el timeout para evitar que la petición POST se cuelgue 2 minutos
    timeout: 10000, 
    connectionTimeout: 10000 
});

/**
 * Función para enviar el correo de verificación.
 */
const sendVerificationEmail = async (userCorreo, verificationToken) => {
    // Usamos el APP_BASE_URL del .env (o la variable de Railway)
    const verificationUrl = `${process.env.APP_BASE_URL}/auth/verify?token=${verificationToken}`;

    const mailOptions = {
        from: `"WaterKontrol" <${process.env.EMAIL_USER}>`,
        to: userCorreo,
        subject: 'Verifica tu cuenta de WaterKontrol',
        html: `
            <h2>¡Gracias por registrarte!</h2>
            <p>Por favor, haz clic en el siguiente enlace para verificar tu dirección de correo electrónico:</p>
            <a href="${verificationUrl}" style="padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px;">Verificar Correo Electrónico</a>
            <p>Si no te registraste, puedes ignorar este correo.</p>
        `,
    };

    // CRÍTICO: Usar try-catch para manejar fallos de red/servidor SMTP
    try {
        await transporter.sendMail(mailOptions);
        console.log(`✉️ Correo de verificación enviado a ${userCorreo}`);
        return true;
    } catch (error) {
        // El timeout de 10s se reflejará aquí, pero la respuesta 201 ya se dio.
        console.error(`❌ Falló el envío del correo a ${userCorreo}: ${error.message}`);
        return false;
    }
};

/**
 * Función para enviar el correo de bienvenida.
 */
const sendWelcomeEmail = async (userCorreo, userName) => {
    try {
        const mailOptions = {
            from: `"WaterKontrol" <${process.env.EMAIL_USER}>`,
            to: userCorreo,
            subject: '¡Bienvenido a WaterKontrol! Tu cuenta está activa',
            html: `
                <h2>¡Hola, ${userName}!</h2>
                <p>Tu cuenta ha sido verificada y activada con éxito. Ya puedes iniciar sesión y comenzar a gestionar tus dispositivos.</p>
                <p>Saludos cordiales,<br>El equipo de WaterKontrol.</p>
            `,
        };
        await transporter.sendMail(mailOptions);
        console.log(`✉️ Correo de bienvenida enviado a ${userCorreo}`);
    } catch (error) {
         console.error(`❌ Falló el envío del correo de bienvenida a ${userCorreo}:`, error.message);
    }
};


// ===================================================================================
// RUTAS DE AUTENTICACIÓN (LOGIN, REGISTER, VERIFY) Y ARCHIVOS ESTÁTICOS
// ===================================================================================

// Middleware para servir archivos estáticos (HTML, CSS) desde la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public'))); 

// Ruta raíz: Sirve la página de login
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html')); 
});

// Endpoint POST para LOGIN
app.post('/auth/login', async (req, res) => {
    const { correo, clave } = req.body; 

    if (!correo || !clave) {
        return res.status(400).send('Faltan credenciales (correo/clave).');
    }

    try {
        const userQuery = 'SELECT usr_id, nombre, clave, correo, estatus FROM usuario WHERE correo = $1'; 
        const result = await pool.query(userQuery, [correo]);
        const user = result.rows[0];

        if (!user) {
            return res.status(401).send('Credenciales inválidas. (Usuario no encontrado)');
        }

        if (user.estatus === 0) {
            return res.status(403).send('Tu cuenta aún no ha sido verificada. Revisa tu correo electrónico para el enlace de verificación.');
        }

        const match = await bcrypt.compare(clave, user.clave);

        if (match) {
            console.log(`🔑 Login Exitoso: Usuario ${correo}`);
            res.status(200).send(`¡Login Exitoso! Bienvenido, ${user.nombre}. Redirigiendo...`);
        } else {
            return res.status(401).send('Credenciales inválidas. (Clave incorrecta)');
        }

    } catch (error) {
        console.error('❌ Error en el proceso de login:', error.message);
        res.status(500).send('Error interno del servidor durante el login.');
    }
});

// Endpoint POST para REGISTRO
app.post('/auth/register', async (req, res) => {
    const { nombre, correo, clave } = req.body; 

    if (!nombre || !correo || !clave) {
        return res.status(400).send('Todos los campos (nombre, correo, clave) son obligatorios.');
    }

    let client;
    try {
        client = await pool.connect();
        const hashedPassword = await bcrypt.hash(clave, saltRounds);
        const verificationToken = crypto.randomBytes(32).toString('hex'); 

        // 1. Inserción en la Base de Datos
        const registerQuery = `
            INSERT INTO usuario (nombre, correo, clave, token_verificacion, estatus) 
            VALUES ($1, $2, $3, $4, 0) 
            RETURNING usr_id, nombre
        `;
        await client.query(registerQuery, [nombre, correo, hashedPassword, verificationToken]);

        // 2. Envío del Correo (Manejará el timeout de 10s o la conexión exitosa)
        await sendVerificationEmail(correo, verificationToken); 
        
        console.log(`📝 Registro Exitoso: Nuevo usuario ${correo}. Esperando verificación.`);
        // CRÍTICO: Responder inmediatamente con éxito (201) ya que el usuario SÍ está en DB
        res.status(201).send(`Registro Exitoso. Se ha enviado un correo de verificación a ${correo}. Por favor, revisa tu bandeja de entrada. (Puede tardar si hay problemas con el servidor de correo)`);

    } catch (error) {
        if (error.code === '23505') { 
            return res.status(409).send('El correo ya está registrado. Por favor, inicia sesión.');
        }
        // Este catch solo debe atrapar errores de DB o de hashing.
        console.error('❌ Error en el proceso de registro (general):', error.message);
        res.status(500).send('Error interno del servidor durante el registro.');
    } finally {
        if (client) {
            client.release();
        }
    }
});

// ENDPOINT DE VERIFICACIÓN: /auth/verify 
app.get('/auth/verify', async (req, res) => {
    const token = req.query.token;

    if (!token) {
        return res.status(400).send('Token de verificación faltante o inválido.');
    }

    try {
        const userQuery = `
            SELECT usr_id, nombre, correo FROM usuario 
            WHERE token_verificacion = $1 AND estatus = 0
        `;
        const result = await pool.query(userQuery, [token]);
        const user = result.rows[0];

        if (!user) {
            // Este es el caso cuando el token ya fue usado (estatus != 0) o es incorrecto
            return res.status(404).send('Enlace de verificación inválido o expirado. La cuenta ya puede estar activa. Por favor, intenta iniciar sesión.');
        }

        const updateQuery = `
            UPDATE usuario 
            SET estatus = 1, token_verificacion = NULL 
            WHERE usr_id = $1 
            RETURNING nombre, correo
        `;
        await pool.query(updateQuery, [user.usr_id]);

        await sendWelcomeEmail(user.correo, user.nombre);

        console.log(`✅ Verificación Exitosa: Usuario ${user.correo} activado.`);
        
        // Respuesta HTML
        res.status(200).send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <title>Verificación Exitosa</title>
                <style>
                    body { font-family: sans-serif; text-align: center; padding: 50px; }
                    .success { color: green; border: 1px solid green; padding: 20px; border-radius: 8px; max-width: 400px; margin: 0 auto; }
                </style>
            </head>
            <body>
                <div class="success">
                    <h2>¡Verificación Exitosa!</h2>
                    <p>Tu cuenta ha sido activada correctamente, ${user.nombre}.</p>
                    <p>¡Te hemos enviado un correo de bienvenida!</p>
                    <a href="${process.env.APP_BASE_URL}" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px;">Ir al Login</a>
                </div>
            </body>
            </html>
        `);

    } catch (error) {
        console.error('❌ Error durante la verificación:', error.message);
        res.status(500).send('Error interno del servidor al verificar la cuenta.');
    }
});

// Endpoint POST para OLVIDÉ CONTRASEÑA (Simulación)
app.post('/auth/forgot', (req, res) => {
    const correo = req.body.correo;
    if (!correo) {
        return res.status(400).send('El correo es requerido.');
    }
    console.log(`Recuperación solicitada para: ${correo}`);
    res.status(200).send('Si la cuenta está registrada, recibirás un correo electrónico con instrucciones para restablecer tu contraseña.');
});


// ===================================================================================
// ENDPOINTS DE API Y MQTT EXISTENTES
// ===================================================================================

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.post('/dispositivo', async (req, res) => {
  const { modelo, tipo, serie, marca, estatus } = req.body;
  if (!modelo || !tipo || !serie || !estatus) {
    return res.status(400).json({ error: 'Los campos modelo, tipo, serie y estatus son obligatorios.' });
  }

  const query = `
    INSERT INTO dispositivo (modelo, tipo, serie, marca, estatus)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING dsp_id;
  `;

  try {
    const result = await pool.query(query, [modelo, tipo, serie, marca, estatus]);
    res.status(201).json({
      message: 'Dispositivo creado con éxito.',
      dsp_id: result.rows[0].dsp_id
    });
  } catch (error) {
    console.error('❌ Error al crear el dispositivo:', error.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

app.post('/dispositivo/parametros', async (req, res) => {
    const { dsp_id, prt_ids } = req.body;
    if (!dsp_id || !prt_ids || !Array.isArray(prt_ids) || prt_ids.length === 0) {
      return res.status(400).json({ error: 'Los campos dsp_id y prt_ids (array de IDs) son obligatorios.' });
    }
  
    let dbClient;
    try {
      dbClient = await pool.connect();
      await dbClient.query('BEGIN'); 
  
      const insertPromises = prt_ids.map(prt_id => {
        const query = 'INSERT INTO dispositivo_parametro (dsp_id, prt_id) VALUES ($1, $2) ON CONFLICT (dsp_id, prt_id) DO NOTHING';
        return dbClient.query(query, [dsp_id, prt_id]);
      });
  
      await Promise.all(insertPromises);
      await dbClient.query('COMMIT'); 
  
      res.status(201).json({
        message: `Asociación de ${insertPromises.length} parámetros al dispositivo ${dsp_id} completada.`
      });
  
    } catch (error) {
      if (dbClient) {
        await dbClient.query('ROLLBACK'); 
      }
      console.error('❌ Error al asociar parámetros:', error);
      res.status(500).json({ error: 'Error interno del servidor.' });
    } finally {
      if (dbClient) {
        dbClient.release();
      }
    }
});

app.post('/registro', async (req, res) => {
    const { usr_id, dsp_id, topic } = req.body;
    if (!usr_id || !dsp_id || !topic) {
      return res.status(400).json({ error: 'Los campos usr_id, dsp_id y topic son obligatorios.' });
    }
  
    const query = `
      INSERT INTO registro (usr_id, dsp_id, topic)
      VALUES ($1, $2, $3)
      RETURNING rgt_id;
    `;
  
    try {
      const result = await pool.query(query, [usr_id, dsp_id, topic]);
      res.status(201).json({
        message: 'Registro de vinculación creado con éxito.',
        rgt_id: result.rows[0].rgt_id
      });
    } catch (error) {
      if (error.code === '23505') { 
        return res.status(409).json({ error: 'El topic MQTT ya está en uso. Debe ser único.' });
      }
      console.error('❌ Error al crear el registro de vinculación:', error);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

const procesarMensajesMqtt = () => {
  console.log('Iniciando servicio de escucha MQTT...');

  const client = mqtt.connect(process.env.MQTT_BROKER_URL);
  const topicMaestro = 'dispositivos/+/telemetria';

  client.on('connect', () => {
    console.log('✅ Conectado al broker MQTT.');
    client.subscribe(topicMaestro, (err) => {
      if (err) {
        console.error('❌ Error al suscribirse al topic maestro:', err);
      } else {
        console.log(`✅ Suscrito exitosamente al topic: ${topicMaestro}`);
      }
    });
  });

  client.on('message', async (topic, message) => {
    console.log(`📥 Mensaje recibido en el topic [${topic}]: ${message.toString()}`);
    let dbClient;
    try {
      const data = JSON.parse(message.toString());
      if (!data.parametros || typeof data.parametros !== 'object') {
        throw new Error('El formato del JSON es incorrecto.');
      }

      dbClient = await pool.connect(); 
      const registroRes = await dbClient.query('SELECT rgt_id, dsp_id FROM registro WHERE topic = $1', [topic]);
      if (registroRes.rows.length === 0) {
        throw new Error(`No se encontró ningún registro para el topic: ${topic}`);
      }
      const { rgt_id, dsp_id } = registroRes.rows[0];

      await dbClient.query('BEGIN');

      const insertMensajeQuery = 'INSERT INTO mensajes (rgt_id, status) VALUES ($1, $2) RETURNING msg_id';
      const mensajeRes = await dbClient.query(insertMensajeQuery, [rgt_id, 1]);
      const msg_id = mensajeRes.rows[0].msg_id;

      const parametrosRes = await dbClient.query('SELECT p.prt_id, p.nombre FROM parametros p JOIN dispositivo_parametro dp ON p.prt_id = dp.prt_id WHERE dp.dsp_id = $1', [dsp_id]);
      const parametrosMap = parametrosRes.rows.reduce((map, row) => {
        map[row.nombre] = row.prt_id; 
        return map;
      }, {});

      for (const [nombreParametro, valorParametro] of Object.entries(data.parametros)) {
        const prt_id = parametrosMap[nombreParametro];

        if (prt_id) {
          if (typeof valorParametro !== 'number') {
             console.warn(`⚠️ Valor no numérico para el parámetro ${nombreParametro}. Se intentará convertir.`);
          }
          const insertParametroQuery = 'INSERT INTO parametros_mensajes (msg_id, prt_id, valor) VALUES ($1, $2, $3)';
          await dbClient.query(insertParametroQuery, [msg_id, prt_id, valorParametro]);
        } else {
          console.warn(`⚠️ Parámetro desconocido "${nombreParametro}" recibido. Se ignorará.`);
        }
      }

      await dbClient.query('COMMIT');
      console.log(`✅ Mensaje del topic [${topic}] procesado y guardado con éxito (MSG_ID: ${msg_id}).`);

    } catch (error) {
      if (dbClient) {
        await dbClient.query('ROLLBACK');
      }
      console.error(`❌ Error procesando mensaje del topic [${topic}]:`, error.message);
    } finally {
      if (dbClient) {
        dbClient.release();
      }
    }
  });

  client.on('error', (error) => {
    console.error('❌ Error en la conexión MQTT:', error);
  });
};


// ===================================================================================
// INICIAR EL SERVIDOR EXPRESS
// ===================================================================================
const PORT = process.env.PORT || 8080; 

const startServer = async () => {
    console.log('🚀 Iniciando servidor...');

    const dbConnected = await testDatabaseConnection();
    
    if (!dbConnected) {
        console.error('❌ No se pudo conectar a la base de datos. Las funciones de autenticación y DB fallarán.');
        // No salimos con exit(1) para que el frontend pueda cargar.
    }

    // CRÍTICO: Asegurarse de escuchar en 0.0.0.0 si es Railway
    const host = isProduction ? '0.0.0.0' : 'localhost';

    app.listen(PORT, host, () => {
        console.log(`✅ Servidor Express ejecutándose en ${host}:${PORT}`);
        
        if (dbConnected) {
             procesarMensajesMqtt();
        } else {
             console.warn('⚠️ MQTT y APIs de DB podrían no funcionar. El frontend del login sí.');
        }
    });
};

startServer();