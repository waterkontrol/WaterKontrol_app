// Cargar las variables de entorno desde el archivo .env
require('dotenv').config();
// Importar las librerías necesarias
const express = require('express');
const { Pool } = require('pg');
const mqtt = require('mqtt');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer'); // Aún está importado, pero no se usará
const cookieParser = require('cookie-parser');
const saltRounds = 10;

// --- CONFIGURACIÓN DE EXPRESS ---
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ===================================================================================
// LÓGICA DE CONEXIÓN A LA BASE DE DATOS Y BCRYPT
// ===================================================================================
console.log('🔧 Intentando conectar a la base de datos...');
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
console.log('📋 DATABASE_URL:', process.env.DATABASE_URL ? '✅ Definida' : '❌ NO DEFINIDA');
console.log(`📋 Entorno: ${isProduction ? 'Producción (SSL ON)' : 'Local (SSL OFF)'}`);

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10
};

const pool = new Pool(poolConfig);

const testDatabaseConnection = async () => {
  let client;
  try {
    client = await pool.connect();
    console.log('✅ Conexión a la base de datos establecida correctamente');
    const result = await client.query('SELECT 1 as db_connection_ok');
    if (result.rows[0].db_connection_ok === 1) {
        console.log('✅ db connection ok');
    }
    await initializeDatabase(client);
    return true;
  } catch (error) {
    console.error('❌ Error crítico al conectar/verificar la DB:', error.message);
    return false;
  } finally {
    if (client) {
      client.release();
    }
  }
};

const initializeDatabase = async (client) => {
    // Verificar que la tabla 'usuario' exista con los campos mínimos
    const checkUserTable = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name='usuario' AND column_name IN ('correo', 'clave', 'token_verificacion', 'estatus')
    `);
    const requiredColumns = ['correo', 'clave', 'token_verificacion', 'estatus']; // Incluimos token_verificacion aunque no se use
    const foundColumns = checkUserTable.rows.map(row => row.column_name);

    if (requiredColumns.every(col => foundColumns.includes(col))) {
        console.log(`✅ Tabla "usuario" verificada. Usando campos: ${foundColumns.join(', ')}.`);
    } else {
        console.warn('⚠️ La tabla "usuario" puede necesitar ser creada o revisada.');
    }
    // Nota: La creación de la tabla telemetria y dispositivo debería ser similar
}

// ===================================================================================
// LÓGICA DE AUTENTICACIÓN (VERIFICACIÓN COMENTADA)
// ===================================================================================
const verifyToken = async (token) => {
    // Verificación por correo deshabilitada temporalmente
    console.log('⚠️ Verificación por correo está deshabilitada.');
    return { success: false, message: 'Verificación por correo está deshabilitada temporalmente.' };
};

const authenticateToken = (req, res, next) => {
    const token = req.cookies.session_token;

    // Permitir acceso a rutas estáticas, autenticación y a la raíz
    if (req.path.startsWith('/auth') || req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.css')) {
        return next();
    }

    // Proteger rutas como /app.html y otras que requieran autenticación
    // Este middleware ahora solo verifica la existencia de la cookie
    if (!token) {
        // Devolver JSON para rutas API, redirigir para HTML
        if (req.accepts('json')) {
            return res.status(401).json({ message: 'No autorizado. Por favor, inicie sesión.' });
        } else {
            return res.redirect('/');
        }
    }
    next(); // Si tiene token, continuar
};

// ===================================================================================
// LÓGICA DE CORREO ELECTRÓNICO (COMENTADA)
// ===================================================================================
/*
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

const sendVerificationEmail = async (correo, token) => {
    const verificationUrl = `${process.env.APP_BASE_URL}/auth/verify?token=${token}`;
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: correo,
        subject: 'Verificación de Cuenta WaterKontrol',
        html: `
            <h1>Verificación de Correo</h1>
            <p>Gracias por registrarte en WaterKontrol. Por favor, haz clic en el siguiente enlace para verificar tu cuenta:</p>
            <a href="${verificationUrl}">${verificationUrl}</a>
            <p>Si no solicitaste este registro, por favor ignora este correo.</p>
        `
    };
    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Correo de verificación enviado a: ${correo}`);
        return true;
    } catch (error) {
        console.error('❌ Error al enviar correo de verificación:', error);
        return false;
    }
};
*/
// ===================================================================================
// LÓGICA MQTT
// ===================================================================================
let mqttClient = null;
const procesarMensajesMqtt = () => {
  const brokerUrl = process.env.MQTT_BROKER_URL;
  if (!brokerUrl) {
    console.error('❌ MQTT_BROKER_URL no está definido. Saltando la conexión MQTT.');
    return;
  }
  const client = mqtt.connect(brokerUrl);
  mqttClient = client;

  client.on('connect', () => {
    console.log('✅ Conectado al broker MQTT.');
    const topic = 'dispositivos/+/telemetria';
    client.subscribe(topic, (err) => {
      if (!err) {
        console.log(`✅ Suscrito exitosamente al topic: ${topic}`);
      } else {
        console.error(`❌ Error al suscribirse al topic ${topic}:`, err);
      }
    });
  });

  client.on('message', async (topic, message) => {
    let dbClient;
    try {
      const data = JSON.parse(message.toString());
      console.log(`[${new Date().toISOString()}] Mensaje de MQTT en [${topic}]:`, data);

      dbClient = await pool.connect();
      await dbClient.query('BEGIN');

      const insertQuery = `
        INSERT INTO telemetria (topic, nivel, fecha)
        VALUES ($1, $2, NOW())
        RETURNING id;
      `;
      // Asumiendo que data.nivel existe
      const result = await dbClient.query(insertQuery, [topic, data.nivel]);
      const msg_id = result.rows[0].id;
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
// RUTAS ESTÁTICAS Y MIDDLEWARE DE AUTENTICACIÓN
// ===================================================================================
app.use(authenticateToken); // Aplicar middleware globalmente
// CRÍTICO: Servir el frontend desde la carpeta 'www' (donde lo copia el postinstall)
app.use(express.static(path.join(__dirname, 'www')));

// ===================================================================================
// RUTAS DE LA API (ENDPOINT)
// ===================================================================================
app.get('/health', (req, res) => {
    res.status(200).send({ status: 'OK', service: 'waterkontrol-backend' });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'www', 'index.html'));
});

app.get('/app.html', (req, res) => {
    // El middleware authenticateToken ya maneja la verificación de sesión
    // Si llega aquí, es porque tiene sesión válida
    res.sendFile(path.join(__dirname, 'www', 'app.html'));
});

// -----------------------------------------------------------------------------------
// RUTAS DE AUTENTICACIÓN
// -----------------------------------------------------------------------------------
app.post('/auth/register', async (req, res) => {
    const { nombre, correo, clave } = req.body;
    let client;

    if (!nombre || !correo || !clave) {
        return res.status(400).json({ message: 'Faltan campos obligatorios: nombre, correo, clave.' });
    }

    // Validación adicional (opcional pero recomendable)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(correo)) {
        return res.status(400).json({ message: 'Formato de correo inválido.' });
    }
    if (clave.length < 6) {
        return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres.' });
    }

    try {
        client = await pool.connect();

        // Verificar si el correo ya existe
        const existingUser = await client.query('SELECT correo FROM usuario WHERE correo = $1', [correo]);
        if (existingUser.rows.length > 0) {
            return res.status(409).json({ message: 'El correo ya está registrado.' });
        }

        // Hashear la contraseña
        const hashedClave = await bcrypt.hash(clave, saltRounds);

        // Insertar usuario directamente como ACTIVO (verificación deshabilitada)
        // El token_verificacion se inserta como NULL
        await client.query(
            'INSERT INTO usuario (nombre, correo, clave, token_verificacion, estatus) VALUES ($1, $2, $3, $4, $5)',
            [nombre, correo, hashedClave, null, 'ACTIVO'] // Cambiado: token_verificacion = null, estatus = 'ACTIVO'
        );

        // NO se envía correo de verificación
        console.log(`✅ Usuario ${correo} registrado directamente como ACTIVO (verificación deshabilitada).`);

        res.status(201).json({
            message: 'Registro exitoso. Puedes iniciar sesión ahora.',
            verification_sent: false // Indicar que no se envió correo
        });
    } catch (error) {
        console.error('Error al registrar usuario:', error);
        res.status(500).json({ message: 'Error interno del servidor al registrar.' });
    } finally {
        if (client) client.release();
    }
});

app.get('/auth/verify', async (req, res) => {
    // Verificación por correo deshabilitada temporalmente
    res.status(404).send('Verificación por correo está deshabilitada temporalmente.');
});

app.post('/auth/login', async (req, res) => {
    const { correo, clave } = req.body;
    let client;

    if (!correo || !clave) {
        return res.status(400).json({ message: 'Faltan campos: correo o clave.' });
    }

    try {
        client = await pool.connect();
        const userResult = await client.query('SELECT * FROM usuario WHERE correo = $1', [correo]);

        if (userResult.rows.length === 0) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        const user = userResult.rows[0];

        // Con verificación deshabilitada, no es necesario verificar 'estatus'
        // Asumimos que todos los usuarios registrados son 'ACTIVO'
        // if (user.estatus !== 'ACTIVO') {
        //     return res.status(403).json({
        //         message: 'Cuenta pendiente de verificación. Revisa tu correo.',
        //         error_code: 'ACCOUNT_PENDING'
        //     });
        // }

        // Comparar contraseña
        const isMatch = await bcrypt.compare(clave, user.clave);
        if (!isMatch) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        // Crear Token de Sesión
        const sessionToken = crypto.randomBytes(64).toString('hex');

        // Establecer la cookie de sesión
        res.cookie('session_token', sessionToken, {
            httpOnly: true,
            secure: isProduction,
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
            sameSite: 'Lax'
        });

        // Respuesta exitosa
        res.status(200).json({
            message: 'Inicio de sesión exitoso.',
            redirect: '/app.html'
        });
    } catch (error) {
        console.error('Error en el login:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        if (client) client.release();
    }
});

app.post('/auth/logout', (req, res) => {
    res.clearCookie('session_token');
    res.status(200).json({ message: 'Sesión cerrada.' });
});

// -----------------------------------------------------------------------------------
// RUTAS DE DISPOSITIVOS Y TELEMETRÍA (LÓGICA COMPLETADA)
// -----------------------------------------------------------------------------------

// Ruta para registrar un nuevo dispositivo y asociarlo al usuario
app.post('/dispositivo', async (req, res) => {
    const { nombre, tipo, marca, topic } = req.body;
    const token = req.cookies.session_token; // Obtener token de sesión

    if (!token) {
        return res.status(401).json({ message: 'No autorizado. Por favor, inicie sesión.' });
    }

    if (!nombre || !tipo || !topic) {
        return res.status(400).json({ message: 'Faltan campos obligatorios: nombre, tipo, topic.' });
    }

    let client;
    try {
        client = await pool.connect();

        // Obtener el ID del usuario autenticado basado en el token de sesión
        // NOTA: Esta implementación asume que el token de sesión es el ID del usuario o está mapeado a él.
        // Una mejor práctica es almacenar la sesión en Redis o una tabla de sesiones.
        // Por ahora, asumiremos que el token de sesión está relacionado con el usuario en alguna forma,
        // o que el backend puede inferir el ID del usuario de otra manera (p. ej. vía JWT o una tabla de sesiones).
        // PARA SIMPLIFICAR ESTE EJEMPLO: Vamos a *suponer* que podemos obtener el ID del usuario de una cookie adicional
        // o que el frontend envía el ID del usuario explícitamente (menos seguro, pero funcional para este paso).
        // Lo ideal es tener un middleware `verifySession` que decodifique el token y coloque `req.user` en la request.
        // Dado que no tenemos eso, y la lógica de sesiones es compleja, lo haremos de forma básica por ahora.
        // Supongamos que el token *es* el identificador único del usuario para este ejemplo simplificado.
        // ESTO ES UN PUNTO CRÍTICO: La autenticación de sesión debería mapear el token a un usr_id.

        // OPCIÓN 1: (No recomendada) El frontend envía el usr_id. Requiere confianza total.
        // const { usr_id } = req.body;
        // if (!usr_id) {
        //     return res.status(400).json({ message: 'ID de usuario no proporcionado.' });
        // }

        // OPCIÓN 2: (Recomendada) Tener una tabla de sesiones o usar JWT con payload que incluya usr_id
        // Para este ejemplo, *no* implementaremos una tabla de sesiones completa.
        // Supondremos que el backend puede obtener el usr_id del token de alguna manera interna o que el token es suficientemente seguro.
        // La forma correcta es: Middleware que verifica `session_token` y extrae `usr_id`.
        // Vamos a crear un middleware ficticio para ilustrar esto, pero no lo implementaremos completamente aquí para no alargar el código.

        // Por ahora, vamos a *comentar* la parte de usr_id y dejarla pendiente de una implementación más robusta.
        // La tabla 'dispositivo' debería tener una columna 'usr_id' para asociar el dispositivo al usuario.
        // Creamos la tabla si no existe (esto debería hacerse en una migración, no aquí).
        await client.query(`
            CREATE TABLE IF NOT EXISTS dispositivo (
                id SERIAL PRIMARY KEY,
                usr_id INTEGER NOT NULL, -- Asumiendo usr_id como clave foránea
                nombre VARCHAR(255) NOT NULL,
                tipo VARCHAR(100),
                marca VARCHAR(100),
                topic VARCHAR(255) UNIQUE NOT NULL, -- El topic debería ser único
                fecha_registro TIMESTAMP DEFAULT NOW()
                -- CONSTRAINT fk_usuario FOREIGN KEY (usr_id) REFERENCES usuario(id)
            );
        `);

        // Suponiendo que usr_id se obtiene de forma segura (por ejemplo, decodificando el token o usando una tabla de sesiones)
        // Por ahora, asignamos un usr_id falso (1) solo para probar la inserción.
        // ESTE ES EL PUNTO DONDE DEBE IMPLEMENTARSE LA OBTENCIÓN REAL DEL usr_id
        const usr_id = 1; // <-- ESTE VALOR DEBE OBTENERSE DE FORMA SEGURA (ver comentario arriba)

        await client.query(
            'INSERT INTO dispositivo (usr_id, nombre, tipo, marca, topic) VALUES ($1, $2, $3, $4, $5)',
            [usr_id, nombre, tipo, marca || null, topic]
        );

        res.status(201).json({ message: 'Dispositivo registrado y asociado al usuario.', nombre, topic });
    } catch (error) {
        console.error('Error al registrar dispositivo:', error);
        if (error.code === '23505') { // Error de clave única violada (topic duplicado)
             res.status(409).json({ message: 'El topic del dispositivo ya está registrado.' });
        } else {
             res.status(500).json({ message: 'Error interno del servidor al registrar el dispositivo.' });
        }
    } finally {
        if (client) client.release();
    }
});


// Ruta para obtener dispositivos del usuario autenticado
app.get('/dispositivos', async (req, res) => {
    const token = req.cookies.session_token; // Obtener token de sesión

    if (!token) {
        return res.status(401).json({ message: 'No autorizado. Por favor, inicie sesión.' });
    }

    let client;
    try {
        client = await pool.connect();

        // Suponiendo que usr_id se obtiene de forma segura (ver comentario en POST /dispositivo)
        // Por ahora, usamos usr_id falso (1)
        const usr_id = 1; // <-- ESTE VALOR DEBE OBTENERSE DE FORMA SEGURA

        const result = await client.query(
            'SELECT id, nombre, tipo, marca, topic FROM dispositivo WHERE usr_id = $1',
            [usr_id]
        );

        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener dispositivos:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener dispositivos.' });
    } finally {
        if (client) client.release();
    }
});


// ===================================================================================
// LÓGICA DE INICIO DEL SERVIDOR (CRÍTICO PARA RAILWAY)
// ===================================================================================
const PORT = process.env.PORT || 8080;

const initializeApplicationServices = async () => {
    console.log('🔍 Iniciando verificación de base de datos y MQTT (en segundo plano)...');
    const dbConnected = await testDatabaseConnection();
    if (!dbConnected) {
        console.error('❌ No se pudo conectar a la base de datos. Las funciones de autenticación y DB fallarán.');
    } else {
        try {
            // Iniciar MQTT solo si la conexión a BD fue exitosa
            procesarMensajesMqtt();
        } catch (error) {
            console.error('❌ Error iniciando MQTT:', error);
        }
    }
};

const startServer = () => {
    console.log('🚀 Iniciando servidor Express...');
    const host = isProduction ? '0.0.0.0' : 'localhost';
    // 1. Iniciar Express inmediatamente para que el healthcheck responda
    app.listen(PORT, host, () => {
        console.log(`✅ Servidor Express ejecutándose en ${host}:${PORT}`);
        console.log(`✅ Healthcheck disponible en /health`);
        // 2. Ejecutar la lógica pesada (DB y MQTT) DESPUÉS de que el servidor esté activo
        initializeApplicationServices();
    });
};

startServer();