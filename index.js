// Cargar las variables de entorno desde el archivo .env
require('dotenv').config();

// Importar las librerías necesarias
const express = require('express');
const { Pool } = require('pg');
const mqtt = require('mqtt');

// --- CONFIGURACIÓN ---
const app = express();
app.use(express.json());

// ===================================================================================
// CONEXIÓN MEJORADA A LA BASE DE DATOS
// ===================================================================================
console.log('Intentando conectar a la base de datos...');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'Definida' : 'NO DEFINIDA');

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // Configuraciones adicionales para mejor estabilidad
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 20,
  min: 2
};

const pool = new Pool(poolConfig);

// Verificar conexión a la base de datos al inicio
const testDatabaseConnection = async () => {
  try {
    const client = await pool.connect();
    console.log('✅ Conexión a la base de datos establecida correctamente');
    const result = await client.query('SELECT NOW()');
    console.log('✅ Hora de la base de datos:', result.rows[0].now);
    client.release();
    return true;
  } catch (error) {
    console.error('❌ Error crítico conectando a la base de datos:', error.message);
    console.error('Detalles del error:', error);
    return false;
  }
};

// ===================================================================================
// MIDDLEWARE DE MANEJO DE ERRORES MEJORADO
// ===================================================================================
app.use(async (req, res, next) => {
  try {
    // Verificar conexión a BD antes de cada request que necesite BD
    if (req.path !== '/health') {
      await pool.query('SELECT 1');
    }
    next();
  } catch (error) {
    console.error('Error verificando conexión a BD:', error);
    res.status(503).json({ 
      error: 'Servicio temporalmente no disponible',
      details: 'Error de conexión a la base de datos'
    });
  }
});

// ===================================================================================
// ENDPOINT DE SALUD MEJORADO
// ===================================================================================
app.get('/health', async (req, res) => {
  try {
    // Verificar conexión a la base de datos
    await pool.query('SELECT 1');
    res.status(200).json({ 
      status: 'OK', 
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ 
      status: 'ERROR', 
      database: 'disconnected',
      error: error.message 
    });
  }
});

// ===================================================================================
// ENDPOINT DE API: REGISTRO DE UN NUEVO DISPOSITIVO (MEJORADO)
// ===================================================================================
app.post('/dispositivo', async (req, res) => {
  const { modelo, tipo, serie, marca, estatus } = req.body;

  // Validación de datos de entrada
  if (!modelo || !tipo || !serie || !estatus) {
    return res.status(400).json({ 
      error: 'Los campos modelo, tipo, serie y estatus son obligatorios.' 
    });
  }

  const query = `
    INSERT INTO dispositivo (modelo, tipo, serie, marca, estatus)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING dsp_id;
  `;

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(query, [modelo, tipo, serie, marca, estatus]);
    
    res.status(201).json({
      message: 'Dispositivo creado con éxito.',
      dsp_id: result.rows[0].dsp_id
    });
  } catch (error) {
    console.error('Error al crear el dispositivo:', error);
    
    // Manejo específico de errores de base de datos
    if (error.code === 'ECONNREFUSED' || error.message.includes('connection')) {
      return res.status(503).json({ 
        error: 'Servicio de base de datos no disponible',
        details: 'Verifique la configuración de DATABASE_URL'
      });
    }
    
    if (error.code === '23505') { // Violación de unique constraint
      return res.status(409).json({ 
        error: 'El número de serie ya existe en el sistema'
      });
    }
    
    res.status(500).json({ 
      error: 'Error interno del servidor',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// ===================================================================================
// ENDPOINT DE API: ASOCIAR PARÁMETROS A UN DISPOSITIVO EXISTENTE
// ===================================================================================
app.post('/dispositivo/parametros', async (req, res) => {
  const { dsp_id, prt_ids } = req.body;

  if (!dsp_id || !prt_ids || !Array.isArray(prt_ids) || prt_ids.length === 0) {
    return res.status(400).json({ 
      error: 'Los campos dsp_id y prt_ids (array de IDs) son obligatorios.' 
    });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN'); 

    const insertPromises = prt_ids.map(prt_id => {
      const query = 'INSERT INTO dispositivo_parametro (dsp_id, prt_id) VALUES ($1, $2) ON CONFLICT (dsp_id, prt_id) DO NOTHING';
      return client.query(query, [dsp_id, prt_id]);
    });

    await Promise.all(insertPromises);
    await client.query('COMMIT'); 

    res.status(201).json({
      message: `Asociación de ${prt_ids.length} parámetros al dispositivo ${dsp_id} completada.`
    });

  } catch (error) {
    if (client) {
      await client.query('ROLLBACK'); 
    }
    console.error('Error al asociar parámetros:', error);
    res.status(500).json({ 
      error: 'Error interno del servidor',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// ===================================================================================
// INICIAR EL SERVIDOR EXPRESS
// ===================================================================================
const PORT = process.env.PORT || 3000;

const startServer = async () => {
  // Primero verificar la conexión a la base de datos
  const dbConnected = await testDatabaseConnection();
  
  if (!dbConnected) {
    console.error('❌ No se pudo conectar a la base de datos. Saliendo...');
    process.exit(1);
  }

  // Iniciar servidor Express
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor Express ejecutándose en el puerto ${PORT}`);
    console.log(`✅ Health check disponible en: http://localhost:${PORT}/health`);
    
    // Iniciar MQTT solo si la conexión a BD fue exitosa
    try {
      procesarMensajesMqtt();
    } catch (error) {
      console.error('Error iniciando MQTT:', error);
    }
  });
};

// Mantener el código MQTT existente pero agregar mejor manejo de errores
const procesarMensajesMqtt = () => {
  console.log('Iniciando servicio de escucha MQTT...');

  if (!process.env.MQTT_BROKER_URL) {
    console.warn('⚠️ MQTT_BROKER_URL no definida, servicio MQTT desactivado');
    return;
  }

  const client = mqtt.connect(process.env.MQTT_BROKER_URL);
  const topicMaestro = 'dispositivos/+/telemetria';

  client.on('connect', () => {
    console.log('✅ Conectado al broker MQTT.');
    client.subscribe(topicMaestro, (err) => {
      if (err) {
        console.error('Error al suscribirse al topic maestro:', err);
      } else {
        console.log(`✅ Suscrito exitosamente al topic: ${topicMaestro}`);
      }
    });
  });

  client.on('message', async (topic, message) => {
    console.log(`Mensaje recibido en el topic [${topic}]: ${message.toString()}`);
    
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

      const parametrosRes = await dbClient.query(
        'SELECT p.prt_id, p.nombre FROM parametros p JOIN dispositivo_parametro dp ON p.prt_id = dp.prt_id WHERE dp.dsp_id = $1', 
        [dsp_id]
      );
      
      const parametrosMap = parametrosRes.rows.reduce((map, row) => {
        map[row.nombre] = row.prt_id; 
        return map;
      }, {});

      for (const [nombreParametro, valorParametro] of Object.entries(data.parametros)) {
        const prt_id = parametrosMap[nombreParametro];
        if (prt_id) {
          const insertParametroQuery = 'INSERT INTO parametros_mensajes (msg_id, prt_id, valor) VALUES ($1, $2, $3)';
          await dbClient.query(insertParametroQuery, [msg_id, prt_id, valorParametro]);
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

// Iniciar la aplicación
startServer().catch(error => {
  console.error('❌ Error fatal iniciando la aplicación:', error);
  process.exit(1);
});

// Manejo graceful de shutdown
process.on('SIGTERM', async () => {
  console.log('Recibido SIGTERM, cerrando servidor...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Recibido SIGINT, cerrando servidor...');
  await pool.end();
  process.exit(0);
});