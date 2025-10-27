require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const mqtt = require('mqtt');

const app = express();
app.use(express.json());

// ===================================================================================
// CONFIGURACIÓN DE BASE DE DATOS - VERSIÓN SIMPLIFICADA
// ===================================================================================
console.log('🚀 Iniciando aplicación...');
console.log('📋 DATABASE_URL disponible:', !!process.env.DATABASE_URL);

// Pool de conexiones simplificado
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000
});

// ===================================================================================
// ENDPOINTS ESENCIALES
// ===================================================================================

// Healthcheck simplificado - SOLO verifica que Express funcione
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    service: 'WaterKontrol API',
    timestamp: new Date().toISOString(),
    database: 'checking...'
  });
});

// Endpoint raíz
app.get('/', (req, res) => {
  res.json({ 
    message: 'WaterKontrol API está funcionando',
    version: '1.0.0'
  });
});

// ===================================================================================
// ENDPOINT DISPOSITIVO - CON MANEJO ROBUSTO DE ERRORES
// ===================================================================================
app.post('/dispositivo', async (req, res) => {
  console.log('📦 Recibiendo solicitud para crear dispositivo:', req.body);
  
  const { modelo, tipo, serie, marca, estatus } = req.body;

  // Validación básica
  if (!modelo || !tipo || !serie || !estatus) {
    return res.status(400).json({ 
      error: 'Faltan campos obligatorios: modelo, tipo, serie, estatus',
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
    // Intentar conectar a la base de datos
    client = await pool.connect();
    console.log('✅ Conexión a BD establecida');
    
    // Ejecutar la consulta
    const result = await client.query(query, [modelo, tipo, serie, marca, estatus]);
    console.log('✅ Dispositivo creado con ID:', result.rows[0].dsp_id);
    
    res.status(201).json({
      success: true,
      message: 'Dispositivo creado con éxito.',
      dsp_id: result.rows[0].dsp_id
    });

  } catch (error) {
    console.error('❌ Error en base de datos:', error.message);
    
    // Manejo específico de errores
    if (error.code === '28P01') {
      return res.status(500).json({ 
        error: 'Error de autenticación con la base de datos',
        solution: 'Verificar la variable DATABASE_URL en Railway'
      });
    }
    
    if (error.message.includes('relation "dispositivo" does not exist')) {
      return res.status(500).json({ 
        error: 'La tabla dispositivo no existe',
        solution: 'Ejecutar el script SQL de creación de tablas'
      });
    }
    
    res.status(500).json({ 
      error: 'Error interno del servidor',
      details: error.message
    });
  } finally {
    if (client) {
      client.release();
      console.log('🔓 Conexión liberada');
    }
  }
});

// ===================================================================================
// INICIAR SERVIDOR - VERSIÓN SIMPLIFICADA
// ===================================================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor Express ejecutándose en puerto ${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
  console.log(`✅ Endpoint dispositivo: POST http://localhost:${PORT}/dispositivo`);
  
  // Iniciar MQTT si está configurado
  if (process.env.MQTT_BROKER_URL) {
    console.log('📡 Iniciando servicio MQTT...');
    // Tu código MQTT aquí
  }
});

console.log('🔧 Configuración completada, iniciando servidor...');