// Cargar las variables de entorno desde el archivo .env
require('dotenv').config();

// Importar las librerías necesarias
const express = require('express');
const { Pool } = require('pg');
const mqtt = require('mqtt');
const path = require('path');
const bcrypt = require('bcrypt'); // Necesario para cifrar y comparar contraseñas
const saltRounds = 10; // Nivel de cifrado para bcrypt

// --- CONFIGURACIÓN ---
const app = express();
app.use(express.json()); // Middleware para que Express entienda peticiones JSON
app.use(express.urlencoded({ extended: true })); // Para manejar datos de formularios (Login/Register)

// ===================================================================================
// LÓGICA DE CONEXIÓN A LA BASE DE DATOS (CORRECCIÓN SSL LOCAL/RAILWAY)
// ===================================================================================
console.log('🔧 Intentando conectar a la base de datos...');
const isProduction = process.env.NODE_ENV === 'production';
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

// Verificar conexión a la base de datos al inicio
const testDatabaseConnection = async () => {
  let client;
  try {
    client = await pool.connect();
    console.log('✅ Conexión a la base de datos establecida correctamente');
    
    // Verificación de la tabla usuario (solo verificamos columnas clave que sabemos existen)
    await client.query('SELECT usr_id, nombre, correo, clave FROM usuario LIMIT 1');
    console.log(`✅ Tabla "usuario" verificada. Usando campos: correo y clave.`);

    return true;
  } catch (error) {
    console.error('❌ Error crítico conectando a la base de datos:', error.message);
    console.error('🔍 Detalle: Asegúrate de que tu DB local esté corriendo y la tabla "usuario" exista con las columnas "nombre", "correo" y "clave".');
    return false;
  } finally {
    if (client) {
      client.release();
    }
  }
};


// ===================================================================================
// RUTAS DE AUTENTICACIÓN (LOGIN, REGISTER, FORGOT)
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
        // CORRECCIÓN: Quitamos el filtro estatus = 1, ya que la columna podría no existir
        const userQuery = 'SELECT usr_id, nombre, clave, correo FROM usuario WHERE correo = $1'; 
        const result = await pool.query(userQuery, [correo]);
        const user = result.rows[0];

        if (!user) {
            return res.status(401).send('Credenciales inválidas. (Usuario no encontrado)');
        }

        // 1. COMPARACIÓN DE CONTRASEÑA (USANDO BCRYPT)
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

    try {
        // 1. CIFRADO DE CONTRASEÑA (USANDO BCRYPT)
        const hashedPassword = await bcrypt.hash(clave, saltRounds);

        // 2. INSERCIÓN EN LA BASE DE DATOS
        // CORRECCIÓN CRÍTICA: Eliminamos 'rol_id' y 'estatus' de la inserción.
        const registerQuery = `
            INSERT INTO usuario (nombre, correo, clave) 
            VALUES ($1, $2, $3) 
            RETURNING usr_id, nombre
        `;
        const result = await pool.query(registerQuery, [nombre, correo, hashedPassword]);

        console.log(`📝 Registro Exitoso: Nuevo usuario ${correo} (ID: ${result.rows[0].usr_id})`);
        res.status(201).send(`Registro Exitoso. Bienvenido, ${result.rows[0].nombre}. Ahora puedes iniciar sesión.`);

    } catch (error) {
        if (error.code === '23505') { // Código de error de PostgreSQL para clave duplicada (UNIQUE)
            return res.status(409).send('El correo ya está registrado. Por favor, inicia sesión.');
        }
        console.error('❌ Error en el proceso de registro:', error.message);
        // Devolvemos el error detallado para ayudar en la depuración
        res.status(500).send('Error interno del servidor durante el registro. (Detalle: ' + error.message + ')');
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
// ENDPOINTS DE API EXISTENTES (MANTENIDOS)
// ===================================================================================
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ENDPOINT DE API: REGISTRO DE UN NUEVO DISPOSITIVO
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
    res.status(500).json({ error: 'Error interno del servidor. (Detalle: ' + error.message + ')' });
  }
});

// ENDPOINT DE API: ASOCIAR PARÁMETROS A UN DISPOSITOSITIVO EXISTENTE
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

// ENDPOINT DE API: REGISTRO DE VINCULACIÓN
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


// ===================================================================================
// SERVICIO DE ESCUCHA MQTT (MANTENIDO)
// ===================================================================================
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
    }

    app.listen(PORT, () => {
        console.log(`✅ Servidor Express ejecutándose en el puerto ${PORT}`);
        
        if (dbConnected) {
             procesarMensajesMqtt();
        } else {
             console.warn('⚠️ MQTT y APIs de DB podrían no funcionar. El frontend del login sí.');
        }
    });
};

startServer();