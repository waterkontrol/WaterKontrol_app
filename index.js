// Cargar las variables de entorno desde el archivo .env
require('dotenv').config();

// Importar las librerías necesarias
const express = require('express');
const { Pool } = require('pg');
const mqtt = require('mqtt');

// --- CONFIGURACIÓN ---
const app = express();
app.use(express.json()); // Middleware para que Express entienda peticiones JSON

// ===================================================================================
// CONEXIÓN A LA BASE DE DATOS (CRÍTICO PARA EL ERROR 502)
// Usamos la URL completa y SSL requerido por Railway para evitar fallos de conexión
// al intentar el primer POST.
// ===================================================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, 
  ssl: {
    rejectUnauthorized: false // Necesario para conexiones SSL de Railway
  }
});


// ===================================================================================
// ENDPOINT DE SALUD (HEALTHCHECK)
// Asegura que Railway sepa que la aplicación está lista.
// ===================================================================================
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});


// ===================================================================================
// ENDPOINT DE API: REGISTRO DE UN NUEVO DISPOSITIVO
// ===================================================================================
app.post('/dispositivo', async (req, res) => {
  const { modelo, tipo, serie, marca, estatus } = req.body;

  // Validación de datos de entrada
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
    // Si la conexión a la DB falla, este error será capturado.
    console.error('Error al crear el dispositivo:', error.message);
    // Añadimos un mensaje más detallado para debug si falla la DB
    if (error.code === 'ECONNREFUSED' || error.message.includes('timeout')) {
        return res.status(503).json({ error: 'Fallo al conectar a la base de datos. Verifique la variable DATABASE_URL.' });
    }
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ===================================================================================
// ENDPOINT DE API: ASOCIAR PARÁMETROS A UN DISPOSITOSITIVO EXISTENTE
// (El resto del código de API omitido por brevedad, pero debe estar completo)
// ===================================================================================
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
    console.error('Error al asociar parámetros:', error);
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
    console.error('Error al crear el registro de vinculación:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ===================================================================================
// SERVICIO DE ESCUCHA MQTT (Debe estar completo en tu archivo)
// ===================================================================================
const procesarMensajesMqtt = () => {
  console.log('Iniciando servicio de escucha MQTT...');

  // Conectar al broker usando la variable de entorno
  const client = mqtt.connect(process.env.MQTT_BROKER_URL);
  const topicMaestro = 'dispositivos/+/telemetria';

  client.on('connect', () => {
    console.log('Conectado al broker MQTT.');
    client.subscribe(topicMaestro, (err) => {
      if (err) {
        console.error('Error al suscribirse al topic maestro:', err);
      } else {
        console.log(`Suscrito exitosamente al topic: ${topicMaestro}`);
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

      const parametrosRes = await dbClient.query('SELECT p.prt_id, p.nombre FROM parametros p JOIN dispositivo_parametro dp ON p.prt_id = dp.prt_id WHERE dp.dsp_id = $1', [dsp_id]);
      const parametrosMap = parametrosRes.rows.reduce((map, row) => {
        map[row.nombre] = row.prt_id; 
        return map;
      }, {});

      for (const [nombreParametro, valorParametro] of Object.entries(data.parametros)) {
        const prt_id = parametrosMap[nombreParametro];

        if (prt_id) {
          if (typeof valorParametro !== 'number') {
             console.warn(`Valor no numérico para el parámetro ${nombreParametro}. Se intentará convertir.`);
          }
          const insertParametroQuery = 'INSERT INTO parametros_mensajes (msg_id, prt_id, valor) VALUES ($1, $2, $3)';
          await dbClient.query(insertParametroQuery, [msg_id, prt_id, valorParametro]);
        } else {
          console.warn(`Parámetro desconocido "${nombreParametro}" recibido. Se ignorará.`);
        }
      }

      await dbClient.query('COMMIT');
      console.log(`Mensaje del topic [${topic}] procesado y guardado con éxito (MSG_ID: ${msg_id}).`);

    } catch (error) {
      if (dbClient) {
        await dbClient.query('ROLLBACK');
      }
      console.error(`Error procesando mensaje del topic [${topic}]:`, error.message);
    } finally {
      if (dbClient) {
        dbClient.release();
      }
    }
  });

  client.on('error', (error) => {
    console.error('Error en la conexión MQTT:', error);
  });
};

// ===================================================================================
// INICIAR EL SERVIDOR EXPRESS
// ===================================================================================
// Usamos 8080 como puerto de fallback (alternativo) por si Railway no inyecta el PORT a tiempo.
const PORT = process.env.PORT || 8080; 
app.listen(PORT, () => {
  console.log(`Servidor Express ejecutándose en el puerto ${PORT}`);
  
  // Iniciar MQTT SÓLO DESPUÉS de que el servidor Express esté escuchando
  procesarMensajesMqtt();
});