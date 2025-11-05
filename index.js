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
const cookieParser = require('cookie-parser'); // Necesario para la gestión de cookies de sesión
const saltRounds = 10; 

// --- CONFIGURACIÓN DE EXPRESS ---
const app = express();
app.use(express.json()); // Middleware para que Express entienda peticiones JSON
app.use(express.urlencoded({ extended: true })); // Para que Express entienda datos de formularios
app.use(cookieParser()); // Activar middleware de cookies

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
    
    // Verificar que podemos hacer una consulta simple
    const result = await client.query('SELECT 1 as db_connection_ok');
    if (result.rows[0].db_connection_ok === 1) {
        console.log('✅ db connection ok');
    }

    // Opcional: Verificar la tabla 'usuario' y sus campos (asumiendo que ya tienes esta lógica)
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

// Inicializar la DB (Creación de tablas si no existen)
const initializeDatabase = async (client) => {
    // ⚠️ ATENCIÓN: Esta parte asume la existencia de la tabla 'usuario' en tu esquema.
    const checkUserTable = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name='usuario' AND column_name IN ('correo', 'clave', 'token_verificacion', 'estatus')
    `);
    
    const requiredColumns = ['correo', 'clave', 'token_verificacion', 'estatus'];
    const foundColumns = checkUserTable.rows.map(row => row.column_name);
    
    if (requiredColumns.every(col => foundColumns.includes(col))) {
        console.log(`✅ Tabla "usuario" verificada. Usando campos: ${foundColumns.join(', ')}.`);
    } else {
        // Lógica de creación de tabla omitida.
        console.warn('⚠️ La tabla "usuario" puede necesitar ser creada o revisada.');
    }
}


// ===================================================================================
// LÓGICA DE AUTENTICACIÓN
// ===================================================================================

const verifyToken = async (token) => {
    let client;
    try {
        client = await pool.connect();
        const result = await client.query(
            'SELECT correo FROM usuario WHERE token_verificacion = $1 AND estatus = $2',
            [token, 'PENDIENTE']
        );
        if (result.rows.length === 1) {
            await client.query(
                'UPDATE usuario SET estatus = $1, token_verificacion = NULL WHERE correo = $2',
                ['ACTIVO', result.rows[0].correo]
            );
            return { success: true };
        }
        return { success: false, message: 'Token de verificación inválido o ya usado.' };
    } catch (error) {
        console.error('Error en verifyToken:', error);
        return { success: false, message: 'Error interno del servidor.' };
    } finally {
        if (client) client.release();
    }
};

const authenticateToken = (req, res, next) => {
    const token = req.cookies.session_token;
    
    // Si la ruta es estática o de autenticación, la dejamos pasar.
    if (req.path.startsWith('/auth') || req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.css')) {
        return next();
    }

    // Lógica para proteger /app.html
    if (req.path.includes('/app.html')) {
        if (!token) {
            return res.redirect('/');
        }
    }
    
    // ⚠️ RECOMENDACIÓN: Implementa JWT o una verificación real de token en DB para API routes.
    return next(); 
};


// ===================================================================================
// LÓGICA DE CORREO ELECTRÓNICO
// ===================================================================================

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
      await dbClient.query('BEGIN'); // Iniciar transacción

      // ⚠️ Asumo que tienes una tabla 'telemetria' con 'topic', 'nivel', 'fecha'
      const insertQuery = `
        INSERT INTO telemetria (topic, nivel, fecha)
        VALUES ($1, $2, NOW())
        RETURNING id;
      `;
      const result = await dbClient.query(insertQuery, [topic, data.nivel]);
      const msg_id = result.rows[0].id;
      
      await dbClient.query('COMMIT'); // Confirmar transacción
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

// Middleware para proteger todas las rutas excepto las estáticas y de autenticación
app.use(authenticateToken); 

// Servir archivos estáticos (HTML, CSS, JS del frontend)
// CRÍTICO: La carpeta 'www' contiene el build de Capacitor (Frontend).
app.use(express.static(path.join(__dirname, 'www')));
app.use(express.static(path.join(__dirname, 'public')));


// ===================================================================================
// RUTAS DE LA API (ENDPOINT)
// ===================================================================================

// RUTA DE HEALTHCHECK (CRÍTICO: debe responder rápido)
app.get('/health', (req, res) => {
    // Si el servidor Express está vivo, responde 200 OK.
    // Esto satisface el Healthcheck de Railway.
    res.status(200).send({ status: 'OK', service: 'waterkontrol-backend' });
});

// Ruta por defecto: Redirige al login.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'www', 'index.html'));
});

// Ruta para el dashboard (protegida)
app.get('/app.html', (req, res) => {
    // La protección de redirección ya está en authenticateToken, pero se mantiene como backup
    if (!req.cookies.session_token) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'www', 'app.html'));
});

// -----------------------------------------------------------------------------------
// RUTAS DE AUTENTICACIÓN
// -----------------------------------------------------------------------------------

app.post('/auth/register', async (req, res) => {
    const { nombre, correo, clave } = req.body;
    let client;

    if (!nombre || !correo || !clave) {
        return res.status(400).send('Faltan campos obligatorios.');
    }
    
    try {
        client = await pool.connect();
        
        // 1. Verificar si el usuario ya existe
        const existingUser = await client.query('SELECT * FROM usuario WHERE correo = $1', [correo]);
        if (existingUser.rows.length > 0) {
            return res.status(409).send('El correo ya está registrado.');
        }

        // 2. Hash de la contraseña
        const hashedClave = await bcrypt.hash(clave, saltRounds);
        
        // 3. Generar token de verificación
        const verificationToken = crypto.randomBytes(32).toString('hex');

        // 4. Insertar usuario (estatus PENDIENTE)
        await client.query(
            'INSERT INTO usuario (nombre, correo, clave, token_verificacion, estatus) VALUES ($1, $2, $3, $4, $5)',
            [nombre, correo, hashedClave, verificationToken, 'PENDIENTE']
        );

        // 5. Enviar correo de verificación (no bloquea la respuesta)
        sendVerificationEmail(correo, verificationToken); 
        
        res.status(201).send('Registro exitoso. Revisa tu correo para verificar la cuenta.');

    } catch (error) {
        console.error('Error al registrar usuario:', error);
        res.status(500).send('Error interno del servidor al registrar.');
    } finally {
        if (client) client.release();
    }
});

app.get('/auth/verify', async (req, res) => {
    const { token } = req.query;
    if (!token) {
        return res.status(400).send('Token de verificación no proporcionado.');
    }

    const { success, message } = await verifyToken(token);
    
    if (success) {
        // Redirigir al login
        res.redirect('/?message=✅ Cuenta verificada. Puedes iniciar sesión.');
    } else {
        res.status(400).send(`❌ Error de Verificación: ${message}`);
    }
});

app.post('/auth/login', async (req, res) => {
    const { correo, clave } = req.body;
    let client;
    
    try {
        client = await pool.connect();
        const userResult = await client.query('SELECT * FROM usuario WHERE correo = $1', [correo]);
        
        if (userResult.rows.length === 0) {
            return res.status(401).send('Credenciales inválidas.');
        }

        const user = userResult.rows[0];
        
        // 1. Verificar estatus
        if (user.estatus !== 'ACTIVO') {
            return res.status(403).send('Cuenta pendiente de verificación. Revisa tu correo.');
        }

        // 2. Comparar contraseña
        const isMatch = await bcrypt.compare(clave, user.clave);

        if (!isMatch) {
            return res.status(401).send('Credenciales inválidas.');
        }

        // 3. Crear Token de Sesión (simplificado: usa JWT en producción)
        const sessionToken = crypto.randomBytes(64).toString('hex'); 

        // 4. Establecer la cookie de sesión (CRÍTICO para la app)
        res.cookie('session_token', sessionToken, { 
            httpOnly: true, // No accesible por JavaScript en el navegador
            secure: isProduction, // Solo se envía con HTTPS en producción
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días de validez
            sameSite: 'Lax' // Buena opción por defecto
        });
        
        // 5. Respuesta exitosa
        res.status(200).json({ 
            message: 'Inicio de sesión exitoso.', 
            redirect: '/app.html' 
        });

    } catch (error) {
        console.error('Error en el login:', error);
        res.status(500).send('Error interno del servidor.');
    } finally {
        if (client) client.release();
    }
});

app.post('/auth/logout', (req, res) => {
    // Eliminar la cookie de sesión
    res.clearCookie('session_token');
    res.status(200).send('Sesión cerrada.');
});

// Ruta para registrar un dispositivo
app.post('/dispositivo', async (req, res) => {
    // ⚠️ ATENCIÓN: Esta ruta es conceptual. Requiere autenticación y el ID de usuario.
    const { usr_id, dsp_id, topic, tipo, marca } = req.body;
    
    // Aquí iría la lógica para insertar el dispositivo en la tabla 'dispositivo'
    // ...
    
    console.log(`📌 Dispositivo ${dsp_id} intentando registrarse con topic ${topic}.`);
    res.status(200).send({ message: 'Registro de dispositivo recibido (Lógica pendiente de implementar).', dsp_id });
});


// ===================================================================================
// LÓGICA DE INICIO DEL SERVIDOR (FIX CRÍTICO PARA RAILWAY)
// ===================================================================================

const PORT = process.env.PORT || 8080; 

// FUNCIÓN PARA LA LÓGICA DE INICIALIZACIÓN LENTA (DB, MQTT)
const initializeApplicationServices = async () => {
    console.log('🔍 Iniciando verificación de base de datos y MQTT (en segundo plano)...');
    
    const dbConnected = await testDatabaseConnection();
    
    if (!dbConnected) {
        console.error('❌ No se pudo conectar a la base de datos. Las funciones de autenticación y DB fallarán.');
        // No salimos con exit(1). El servidor Express sigue vivo para el Healthcheck.
    } else {
        // Iniciar MQTT solo si la conexión a BD fue exitosa
        try {
            procesarMensajesMqtt();
        } catch (error) {
            console.error('❌ Error iniciando MQTT:', error);
        }
    }
};

// FUNCIÓN PARA INICIAR EXPRESS INMEDIATAMENTE
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

// Llama a la función de inicio
startServer();