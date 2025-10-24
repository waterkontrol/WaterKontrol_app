// Cargar las variables de entorno desde el archivo .env
require('dotenv').config();

// Importar las librerías necesarias
const express = require('express');
const { Pool } = require('pg');
const mqtt = require('mqtt');

// --- CONFIGURACIÓN ---
const app = express();
app.use(express.json()); // Middleware para que Express entienda peticiones JSON

// Configuración CRÍTICA: Usamos la URL completa y SSL requerido por Railway
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Necesario para conexiones SSL de Railway
  }
});

// ===================================================================================
// ENDPOINT DE SALUD (HEALTHCHECK)
// CRÍTICO para el error 502/Connection Refused
// Railway usará este endpoint para saber que la aplicación está lista.
// ===================================================================================
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});


// ===================================================================================
// ENDPOINT DE API: REGISTRO DE UN NUEVO DISPOSITIVO
// Este endpoint solo crea la entidad del dispositivo.
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
    console.error('Error al crear el dispositivo:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ===================================================================================
// ENDPOINT DE API: ASOCIAR PARÁMETROS A UN DISPOSITIVO EXISTENTE
// ===================================================================================
app.post('/dispositivo/parametros', async (req, res) => {
  const { dsp_id, prt_ids } = req.body;

  if (!dsp_id || !prt_ids || !Array.isArray(prt_ids) || prt_ids.length === 0) {
    return res.status(400).json({ error: 'Los campos dsp_id y prt_ids (array de IDs) son obligatorios.' });
  }

  let dbClient;
  try {
    dbClient = await pool.connect();
    await dbClient.query('BEGIN'); // Iniciar la transacción

    const insertPromises = prt_ids.map(prt_id => {
      const query = 'INSERT INTO dispositivo_parametro (dsp_id, prt_id) VALUES ($1, $2) ON CONFLICT (dsp_id, prt_id) DO NOTHING';
      return dbClient.query(query, [dsp_id, prt_id]);
    });

    await Promise.all(insertPromises);
    await dbClient.query('COMMIT'); // Confirmar la transacción

    res.status(201).json({
      message: `Asociación de ${insertPromises.length} parámetros al dispositivo ${dsp_id} completada.`
    });

  } catch (error) {
    if (dbClient) {
      await dbClient.query('ROLLBACK'); // Revertir la transacción en caso de error
    }
    console.error('Error al asociar parámetros:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  } finally {
    if (dbClient) {
      dbClient.release();
    }
  }
});

// ===================================================================================
// ENDPOINT DE API: REGISTRO DE VINCULACIÓN A UN TOPIC MQTT
// Este endpoint asocia un dsp_id y un usr_id a un topic MQTT único.
// ===================================================================================
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
    if (error.code === '23505') { // Código de error para UNIQUE violation (topic ya existe)
      return res.status(409).json({ error: 'El topic MQTT ya está en uso. Debe ser único.' });
    }
    console.error('Error al crear el registro de vinculación:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});


// ===================================================================================
// SERVICIO DE ESCUCHA MQTT: PROCESA MENSAJES DE TELEMETRÍA
// Se ejecuta al iniciar la aplicación y se mantiene escuchando.
// ===================================================================================
const procesarMensajesMqtt = () => {
  console.log('Iniciando servicio de escucha MQTT...');

  // Conectar al broker usando la variable de entorno
  const client = mqtt.connect(process.env.MQTT_BROKER_URL);

  // El topic maestro para suscribirse a todos los dispositivos que envíen telemetría
  // Ej: 'dispositivos/sensor-123/telemetria'
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

  // Este es el listener principal que se activa con cada mensaje que llega
  client.on('message', async (topic, message) => {
    console.log(`Mensaje recibido en el topic [${topic}]: ${message.toString()}`);
    let dbClient;
    try {
      // Parsear el mensaje, esperando un formato JSON específico
      const data = JSON.parse(message.toString());
      if (!data.parametros || typeof data.parametros !== 'object') {
        throw new Error('El formato del JSON es incorrecto. Debe tener una clave "parametros" (objeto de {nombre: valor}).');
      }

      dbClient = await pool.connect(); // Obtener un cliente del pool para la transacción

      // 1. Buscar el ID del registro (rgt_id) asociado a este topic
      const registroRes = await dbClient.query('SELECT rgt_id, dsp_id FROM registro WHERE topic = $1', [topic]);
      if (registroRes.rows.length === 0) {
        throw new Error(`No se encontró ningún registro para el topic: ${topic}`);
      }
      const { rgt_id, dsp_id } = registroRes.rows[0];

      // Iniciar una transacción para asegurar la integridad de los datos
      await dbClient.query('BEGIN');

      // 2. Insertar la cabecera en la tabla 'mensajes'
      const insertMensajeQuery = 'INSERT INTO mensajes (rgt_id, status) VALUES ($1, $2) RETURNING msg_id';
      const mensajeRes = await dbClient.query(insertMensajeQuery, [rgt_id, 1]);
      const msg_id = mensajeRes.rows[0].msg_id;

      // 3. Buscar los IDs de los parámetros asociados a este dispositivo
      const parametrosRes = await dbClient.query('SELECT p.prt_id, p.nombre FROM parametros p JOIN dispositivo_parametro dp ON p.prt_id = dp.prt_id WHERE dp.dsp_id = $1', [dsp_id]);
      const parametrosMap = parametrosRes.rows.reduce((map, row) => {
        map[row.nombre] = row.prt_id; // Mapea el nombre del parámetro a su ID
        return map;
      }, {});

      // 4. Insertar cada parámetro del mensaje en la tabla 'parametros_mensajes'
      for (const [nombreParametro, valorParametro] of Object.entries(data.parametros)) {
        const prt_id = parametrosMap[nombreParametro];

        if (prt_id) {
          // Asegurarse de que el valor sea un número
          if (typeof valorParametro !== 'number') {
             console.warn(`Valor no numérico para el parámetro ${nombreParametro}. Se intentará convertir.`);
          }
          const insertParametroQuery = 'INSERT INTO parametros_mensajes (msg_id, prt_id, valor) VALUES ($1, $2, $3)';
          await dbClient.query(insertParametroQuery, [msg_id, prt_id, valorParametro]);
        } else {
          console.warn(`Parámetro desconocido "${nombreParametro}" recibido. Se ignorará.`);
        }
      }

      // Si todas las inserciones fueron exitosas, confirma la transacción
      await dbClient.query('COMMIT');
      console.log(`Mensaje del topic [${topic}] procesado y guardado con éxito (MSG_ID: ${msg_id}).`);

    } catch (error) {
      // Si algo falla, revierte todos los cambios de la transacción
      if (dbClient) {
        await dbClient.query('ROLLBACK');
      }
      console.error(`Error procesando mensaje del topic [${topic}]:`, error.message);
    } finally {
      // Libera el cliente para que otros puedan usarlo
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

// ===== ⬇️ INICIO DE LA CORRECCIÓN ⬇️ =====

// Define el HOST en '0.0.0.0' para aceptar conexiones desde CUALQUIER IP,
// no solo 'localhost'. Esto es esencial para que el proxy de Railway se conecte.
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  // Modificamos el log para confirmar que está escuchando en el host correcto
  console.log(`Servidor Express ejecutándose en http://${HOST}:${PORT}`);
  
  // Iniciar MQTT SÓLO DESPUÉS de que el servidor Express esté escuchando
  procesarMensajesMqtt();
});
// ===== ⬆️ FIN DE LA CORRECCIÓN ⬆️ =====