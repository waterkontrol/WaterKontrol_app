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
console.log('🔧 Intentando conectar a la base de datos...');
console.log('📋 DATABASE_URL:', process.env.DATABASE_URL ? '✅ Definida' : '❌ NO DEFINIDA');

// CONFIGURACIÓN CRÍTICA PARA RAILWAY
const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  // Configuración SSL mejorada para Railway
  ssl: {
    rejectUnauthorized: false
  },
  // Timeouts aumentados para Railway
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
    const result = await client.query('SELECT NOW() as current_time');
    console.log('✅ Hora de la base de datos:', result.rows[0].current_time);
    
    // Verificar si existe la tabla dispositivo
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'dispositivo'
      );
    `);
    
    console.log('✅ Tabla "dispositivo" existe:', tableCheck.rows[0].exists);
    
    client.release();
    return true;
  } catch (error) {
    console.error('❌ Error crítico conectando a la base de datos:', error.message);
    console.error('🔍 Detalles del error:', error);
    if (client) client.release();
    return false;
  }
};

// ===================================================================================
// MIDDLEWARE DE MANEJO DE ERRORES MEJORADO
// ===================================================================================
app.use(async (req, res, next) => {
  console.log(`📥 ${req.method} ${req.path}`);
  next();
});

// ===================================================================================
// ENDPOINT DE SALUD MEJORADO (CRÍTICO PARA RAILWAY)
// ===================================================================================
app.get('/health', async (req, res) => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    
    res.status(200).json({ 
      status: 'OK', 
      database: 'connected',
      timestamp: new Date().toISOString(),
      service: 'WaterKontrol API'
    });
  } catch (error) {
    console.error('❌ Health check failed:', error);
    res.status(503).json({ 
      status: 'ERROR', 
      database: 'disconnected',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Endpoint de salud básico (sin BD)
app.get('/', (req, res) => {
  res.json({ 
    message: 'WaterKontrol API está funcionando',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ===================================================================================
// ENDPOINT DE API: REGISTRO DE UN NUEVO DISPOSITIVO (MEJORADO)
// ===================================================================================
app.post('/dispositivo', async (req, res) => {
  console.log('📦 Received body:', req.body);
  
  const { modelo, tipo, serie, marca, estatus } = req.body;

  // Validación de datos de entrada
  if (!modelo || !tipo || !serie || !estatus) {
    return res.status(400).json({ 
      error: 'Los campos modelo, tipo, serie y estatus son obligatorios.',
      received: req.body
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
    console.log('🔗 Client connected, executing query...');
    
    const result = await client.query(query, [modelo, tipo, serie, marca, estatus]);
    console.log('✅ Query result:', result.rows[0]);
    
    res.status(201).json({
      message: 'Dispositivo creado con éxito.',
      dsp_id: result.rows[0].dsp_id,
      data: { modelo, tipo, serie, marca, estatus }
    });
  } catch (error) {
    console.error('❌ Error al crear el dispositivo:', error);
    
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
    
    // Si la tabla no existe
    if (error.message.includes('relation "dispositivo" does not exist')) {
      return res.status(500).json({ 
        error: 'La tabla dispositivo no existe en la base de datos',
        details: 'Ejecuta el script de creación de tablas primero'
      });
    }
    
    res.status(500).json({ 
      error: 'Error interno del servidor',
      details: error.message
    });
  } finally {
    if (client) {
      client.release();
      console.log('🔓 Client released');
    }
  }
});

// ===================================================================================
// INICIAR EL SERVIDOR EXPRESS (CONFIGURACIÓN CRÍTICA)
// ===================================================================================
const PORT = process.env.PORT || 3000;

const startServer = async () => {
  console.log('🚀 Iniciando servidor...');
  console.log('📊 Variables de entorno:');
  console.log('- PORT:', process.env.PORT);
  console.log('- NODE_ENV:', process.env.NODE_ENV);
  console.log('- DATABASE_URL:', process.env.DATABASE_URL ? 'Definida' : 'No definida');

  // Primero verificar la conexión a la base de datos
  console.log('🔍 Verificando conexión a la base de datos...');
  const dbConnected = await testDatabaseConnection();
  
  if (!dbConnected) {
    console.error('❌ No se pudo conectar a la base de datos. Saliendo...');
    process.exit(1);
  }

  // Iniciar servidor Express - CRÍTICO: escuchar en 0.0.0.0
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor Express ejecutándose en: http://0.0.0.0:${PORT}`);
    console.log(`✅ Health check disponible en: http://localhost:${PORT}/health`);
    console.log(`✅ Endpoint dispositivo: POST http://localhost:${PORT}/dispositivo`);
    
    // Iniciar MQTT solo si la conexión a BD fue exitosa
    try {
      procesarMensajesMqtt();
    } catch (error) {
      console.error('Error iniciando MQTT:', error);
    }
  });
};

// Función MQTT (mantener tu código actual)
const procesarMensajesMqtt = () => {
  console.log('Iniciando servicio de escucha MQTT...');
  // ... (tu código MQTT actual)
};

// Iniciar la aplicación
startServer().catch(error => {
  console.error('❌ Error fatal iniciando la aplicación:', error);
  process.exit(1);
});