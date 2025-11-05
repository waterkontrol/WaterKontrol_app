// Cargar las variables de entorno desde el archivo .env
require('dotenv').config();

// Importar las librerías necesarias
const express = require('express');
const { Pool } = require('pg');
const mqtt = require('mqtt');
const path = require('path'); // ¡CRÍTICO! Necesario para servir archivos estáticos y rutas
const bcrypt = require('bcrypt'); // Necesario para hashing de contraseñas
const crypto = require('crypto'); // Necesario para generar tokens
const nodemailer = require('nodemailer'); // Necesario para el envío de correos
const cookieParser = require('cookie-parser'); // ¡NUEVO! Necesario para la gestión de cookies de sesión
const saltRounds = 10; 

// --- CONFIGURACIÓN DE EXPRESS ---
const app = express();
app.use(express.json()); 
app.use(express.urlencoded({ extended: true })); 
app.use(cookieParser()); // ¡NUEVO! Activar middleware de cookies

// ===================================================================================
// LÓGICA DE CONEXIÓN A LA BASE DE DATOS Y BCRYPT
// ===================================================================================
console.log('🔧 Intentando conectar a la base de datos...');
// CRÍTICO: Detectar el entorno para configurar SSL y Host
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
    
    // Verificar que podemos hacer una consulta simple para validar la conexión
    const result = await client.query('SELECT $1::text as status', ['db connection ok']);
    console.log(`✅ ${result.rows[0].status}`);

    // Verificar tabla de usuarios
    await verifyUserTable(client);

    return true;
  } catch (err) {
    console.error('❌ Error de conexión/consulta a la base de datos:', err.message);
    return false;
  } finally {
    if (client) {
      client.release();
    }
  }
};

// Función de utilidad para hashear contraseñas
const hashPassword = (password) => {
    return bcrypt.hash(password, saltRounds);
};

// Función de utilidad para verificar la tabla de usuarios
const verifyUserTable = async (client) => {
    try {
        const query = `
            SELECT * FROM usuario LIMIT 0;
        `;
        await client.query(query);
        console.log('✅ Tabla "usuario" verificada. Usando campos: correo, clave, token_verificacion, estatus.');
    } catch (e) {
        console.warn('⚠️ La tabla "usuario" parece no existir. Intente crearla.');
        // Opcional: Crear la tabla si no existe
    }
};

// ===================================================================================
// LÓGICA DE AUTH/SESIÓN (Middleware)
// ===================================================================================

// Middleware para verificar si el usuario está autenticado
const isAuthenticated = async (req, res, next) => {
    // 1. Obtener el token de la cookie
    const token = req.cookies.session_token;

    if (!token) {
        // No hay token, no está autenticado
        return res.redirect('/');
    }

    let client;
    try {
        client = await pool.connect();
        // 2. Buscar el usuario por token
        const query = 'SELECT usr_id FROM usuario WHERE session_token = $1';
        const result = await client.query(query, [token]);

        if (result.rows.length === 0) {
            // Token inválido o expirado
            res.clearCookie('session_token');
            return res.redirect('/');
        }
        
        // 3. Si es válido, adjuntar el ID del usuario a la solicitud
        req.userId = result.rows[0].usr_id;
        next(); // Continuar a la ruta solicitada
    } catch (error) {
        console.error('Error en middleware de autenticación:', error.message);
        res.clearCookie('session_token');
        return res.redirect('/');
    } finally {
        if (client) {
            client.release();
        }
    }
};

// ===================================================================================
// ENDPOINTS DE AUTENTICACIÓN (API)
// ===================================================================================

// -----------------------------------------------------------------------------------
// POST /auth/register: Registro de un nuevo usuario
// -----------------------------------------------------------------------------------
app.post('/auth/register', async (req, res) => {
    const { nombre, correo, clave } = req.body;
    
    if (!nombre || !correo || !clave) {
        return res.status(400).send('Faltan campos obligatorios.');
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // 1. Verificar si el correo ya existe
        const checkQuery = 'SELECT COUNT(*) FROM usuario WHERE correo = $1';
        const checkResult = await client.query(checkQuery, [correo]);

        if (checkResult.rows[0].count > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'El correo ya está registrado.' });
        }

        // 2. Hashear la contraseña y generar token
        const hashedClave = await hashPassword(clave);
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const dspId = `DSP_${crypto.randomBytes(4).toString('hex').toUpperCase()}`; // ID de dispositivo por defecto

        // 3. Insertar el nuevo usuario
        const insertQuery = `
            INSERT INTO usuario (nombre, correo, clave, token_verificacion, estatus, dsp_id) 
            VALUES ($1, $2, $3, $4, 'pendiente', $5) 
            RETURNING usr_id;
        `;
        const result = await client.query(insertQuery, [nombre, correo, hashedClave, verificationToken, dspId]);
        const newUserId = result.rows[0].usr_id;
        
        // 4. Enviar correo de verificación (Lógica simplificada)
        await sendVerificationEmail(correo, verificationToken);

        await client.query('COMMIT');
        
        // La respuesta que espera el frontend debe ser JSON
        res.status(201).json({ 
            message: '✅ Registro exitoso. Revisa tu correo para verificar tu cuenta.',
            redirect: '/index.html'
        });

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK');
        }
        console.error('Error en el registro:', error.message);
        res.status(500).json({ message: 'Error interno del servidor durante el registro.' });
    } finally {
        if (client) {
            client.release();
        }
    }
});

// -----------------------------------------------------------------------------------
// POST /auth/login: Iniciar sesión
// -----------------------------------------------------------------------------------
app.post('/auth/login', async (req, res) => {
    const { correo, clave } = req.body;

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // 1. Buscar usuario por correo
        const userQuery = 'SELECT usr_id, clave, estatus FROM usuario WHERE correo = $1';
        const userResult = await client.query(userQuery, [correo]);

        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(401).send('Credenciales inválidas.');
        }

        const user = userResult.rows[0];

        // 2. Verificar contraseña
        const isPasswordValid = await bcrypt.compare(clave, user.clave);
        if (!isPasswordValid) {
            await client.query('ROLLBACK');
            return res.status(401).send('Credenciales inválidas.');
        }

        // 3. Verificar estatus de la cuenta
        if (user.estatus === 'pendiente') {
            await client.query('ROLLBACK');
            return res.status(403).send('Cuenta no verificada. Revisa tu correo.');
        }

        // 4. Generar y guardar token de sesión
        const sessionToken = crypto.randomBytes(64).toString('hex');
        const updateTokenQuery = 'UPDATE usuario SET session_token = $1 WHERE usr_id = $2';
        await client.query(updateTokenQuery, [sessionToken, user.usr_id]);

        await client.query('COMMIT');

        // 5. Establecer cookie de sesión (CRÍTICO)
        // La cookie debe ser segura (secure: true) si estás en HTTPS (Railway)
        res.cookie('session_token', sessionToken, { 
            httpOnly: true, 
            secure: isProduction, // true en Railway, false en localhost
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 días
        });

        // Respuesta que espera el frontend
        res.status(200).json({ 
            message: '✅ Sesión iniciada.',
            redirect: '/app.html' // Redirigir a la vista de dispositivos
        });

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK');
        }
        console.error('Error en el login:', error.message);
        res.status(500).send('Error interno del servidor.');
    } finally {
        if (client) {
            client.release();
        }
    }
});

// -----------------------------------------------------------------------------------
// POST /auth/logout: Cerrar sesión
// -----------------------------------------------------------------------------------
app.post('/auth/logout', async (req, res) => {
    // 1. Limpiar la cookie de sesión
    res.clearCookie('session_token');

    // Opcional: Limpiar el token de la base de datos (por seguridad)
    const token = req.cookies.session_token;
    if (token) {
        let client;
        try {
            client = await pool.connect();
            const query = 'UPDATE usuario SET session_token = NULL WHERE session_token = $1';
            await client.query(query, [token]);
        } catch (error) {
            console.error('Error al limpiar token de DB:', error.message);
        } finally {
            if (client) {
                client.release();
            }
        }
    }
    
    // 2. Enviar respuesta de éxito
    res.status(200).json({ message: 'Sesión cerrada exitosamente.' });
});


// ===================================================================================
// ENDPOINTS DE LA APLICACIÓN (Requieren Autenticación)
// ===================================================================================

// Middleware que exige autenticación ANTES de acceder a /app/*
app.use('/app.html', isAuthenticated);
app.use('/add_device.html', isAuthenticated);
app.use('/api/dispositivos', isAuthenticated);

// -----------------------------------------------------------------------------------
// GET /api/dispositivos: Obtener la lista de dispositivos del usuario
// -----------------------------------------------------------------------------------
app.get('/api/dispositivos', async (req, res) => {
    // El userId fue adjuntado a la request por el middleware isAuthenticated
    const userId = req.userId;

    let client;
    try {
        client = await pool.connect();

        const query = `
            SELECT dsp_id, tipo, marca, topic
            FROM dispositivo
            WHERE usr_id = $1
            ORDER BY dsp_id;
        `;
        const result = await client.query(query, [userId]);
        
        // Devolver la lista como JSON (CRÍTICO)
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error al obtener dispositivos:', error.message);
        res.status(500).json({ message: 'Error interno al cargar la lista de dispositivos.' });
    } finally {
        if (client) {
            client.release();
        }
    }
});

// -----------------------------------------------------------------------------------
// POST /api/registro: Registrar un nuevo dispositivo
// -----------------------------------------------------------------------------------
app.post('/api/registro', async (req, res) => {
    const { usr_id, dsp_id, topic } = req.body;
    
    if (!usr_id || !dsp_id || !topic) {
        return res.status(400).json({ message: 'Faltan campos obligatorios para el registro.' });
    }

    let client;
    try {
        client = await pool.connect();
        
        // 1. Verificar que el usuario exista
        const userCheck = await client.query('SELECT usr_id FROM usuario WHERE usr_id = $1', [usr_id]);
        if (userCheck.rows.length === 0) {
             return res.status(404).json({ message: 'Usuario no encontrado.' });
        }

        // 2. Insertar el nuevo dispositivo
        const insertQuery = `
            INSERT INTO dispositivo (dsp_id, usr_id, tipo, marca, topic) 
            VALUES ($1, $2, 'Desconocido', 'Genérico', $3);
        `;
        await client.query(insertQuery, [dsp_id, usr_id, topic]);

        // La respuesta que espera el frontend debe ser JSON
        res.status(201).json({ 
            message: `✅ Dispositivo ${dsp_id} registrado exitosamente.`,
        });

    } catch (error) {
        console.error('Error en el registro del dispositivo:', error.message);
        res.status(500).json({ message: 'Error interno del servidor durante el registro de dispositivo.' });
    } finally {
        if (client) {
            client.release();
        }
    }
});


// ===================================================================================
// LÓGICA DE SERVIR ARCHIVOS ESTÁTICOS (CRÍTICO: Mover ESTO AL FINAL)
// ===================================================================================

// Servir archivos estáticos de la carpeta 'public' (HTML, CSS, JS del Frontend)
// Todas las peticiones que NO coincidan con las rutas de API definidas arriba,
// serán buscadas en esta carpeta.
app.use(express.static(path.join(__dirname, 'public')));


// Servir el 'index.html' como página de inicio por defecto
// Usado principalmente para redirigir desde la ruta base /
app.get('/', (req, res) => {
    // Si la sesión es válida, redirigir directamente a la app
    if (req.cookies.session_token) {
        // Podríamos volver a validar el token aquí para ser más seguros
        return res.redirect('/app.html');
    }
    // Si no hay sesión, servir la página de login
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// ===================================================================================
// LÓGICA DEL CORE DEL SERVIDOR (MQTT y Listen)
// ===================================================================================

// Lógica de nodemailer (simplificada)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

const sendVerificationEmail = async (correo, token) => {
    // Usamos APP_BASE_URL para que el enlace sea correcto en Railway o Local
    const verificationUrl = `${process.env.APP_BASE_URL}/auth/verify?token=${token}`;
    
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: correo,
        subject: 'Verificación de Cuenta WaterKontrol',
        html: `
            <h1>Verificación de Cuenta</h1>
            <p>Por favor, haz clic en el siguiente enlace para verificar tu cuenta:</p>
            <a href="${verificationUrl}">${verificationUrl}</a>
            <p>Si no solicitaste este registro, ignora este correo.</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`📧 Enlace de verificación enviado a ${correo}`);
    } catch (error) {
        console.error(`❌ Error enviando email a ${correo}:`, error.message);
    }
};

// ... (Resto de funciones MQTT como procesarMensajesMqtt y startServer)

// Función MQTT (mantener tu lógica de MQTT aquí)
const procesarMensajesMqtt = () => {
  console.log('Iniciando servicio de escucha MQTT...');
  const client = mqtt.connect(process.env.MQTT_BROKER_URL);

  client.on('connect', () => {
    console.log('✅ Conectado al broker MQTT.');
    // Suscribirse a todos los topics de telemetría de dispositivos
    const topicToSubscribe = 'dispositivos/+/telemetria'; 
    client.subscribe(topicToSubscribe, (err) => {
      if (!err) {
        console.log(`✅ Suscrito exitosamente al topic: ${topicToSubscribe}`);
      } else {
        console.error('❌ Error al suscribirse a MQTT:', err);
      }
    });
  });

  client.on('message', async (topic, message) => {
    let dbClient;
    try {
      dbClient = await pool.connect();
      await dbClient.query('BEGIN');
      
      const payload = JSON.parse(message.toString());
      
      // 1. Extraer el dsp_id del topic (ej: 'dispositivos/DSP_XYZ/telemetria')
      const topicParts = topic.split('/');
      const dsp_id = topicParts[1];

      // 2. Obtener el prt_id (ID de parámetro) para cada clave en el payload
      // Esta lógica asume que las claves del JSON (temp, hum, etc.) son los nombres de los parámetros.

      // 3. Insertar el mensaje principal
      const insertMsgQuery = 'INSERT INTO mensajes (dsp_id, timestamp) VALUES ($1, NOW()) RETURNING msg_id';
      const msgResult = await dbClient.query(insertMsgQuery, [dsp_id]);
      const msg_id = msgResult.rows[0].msg_id;
      
      // 4. Procesar cada parámetro del mensaje
      for (const nombreParametro in payload) {
        const valorParametro = payload[nombreParametro];
        
        // Buscar el ID del parámetro en la tabla de referencia
        const prtQuery = 'SELECT prt_id FROM parametro WHERE nombre = $1';
        const prtResult = await dbClient.query(prtQuery, [nombreParametro]);
        
        if (prtResult.rows.length > 0) {
          const prt_id = prtResult.rows[0].prt_id;
          
          // CRÍTICO: Asegurarse de que el valor sea string para insertar
          if (typeof valorParametro !== 'string' && typeof valorParametro !== 'number') {
             console.warn(`Tipo de dato inesperado para el parámetro ${nombreParametro}. Se intentará convertir.`);
          }
          const insertParametroQuery = 'INSERT INTO parametros_mensajes (msg_id, prt_id, valor) VALUES ($1, $2, $3)';
          await dbClient.query(insertParametroQuery, [msg_id, prt_id, String(valorParametro)]);
        } else {
          console.warn(`Parámetro desconocido "${nombreParametro}" recibido. Se ignorará.`);
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
        
        // Iniciar MQTT
        try {
            procesarMensajesMqtt();
        } catch (error) {
            console.error('Error iniciando MQTT:', error);
        }
    });
};

startServer();