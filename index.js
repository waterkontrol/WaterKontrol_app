// Cargar las variables de entorno desde el archivo .env
require('dotenv').config();

// Importar las librerías necesarias
const express = require('express');
const { Pool } = require('pg');
const mqtt = require('mqtt');

// --- CONFIGURACIÓN ---
const app = express();
app.use(express.json()); // Middleware para que Express entienda peticiones JSON

// Configurar la conexión a la base de datos usando las variables del .env
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
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
// SERVICIO DE ESCUCHA MQTT: PROCESA MENSAJES DE TELEMETRÍA
// Se ejecuta al iniciar la aplicación y se mantiene escuchando.
// ===================================================================================
const procesarMensajesMqtt = () => {
  console.log('Iniciando servicio de escucha MQTT...');
  const client = mqtt.connect(process.env.MQTT_BROKER_URL);

  // El '+' es un comodín (wildcard) que nos permite escuchar en múltiples sub-topics.
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
        throw new Error('El formato del JSON es incorrecto. Debe tener una clave "parametros".');
      }

      dbClient = await pool.connect(); // Obtener un cliente del pool para la transacción

      // 1. Buscar el ID del registro (rgt_id) asociado a este topic
      const registroRes = await dbClient.query('SELECT rgt_id FROM registro WHERE topic = $1', [topic]);
      if (registroRes.rows.length === 0) {
        throw new Error(`No se encontró ningún registro para el topic: ${topic}`);
      }
      const rgt_id = registroRes.rows[0].rgt_id;

      // Iniciar una transacción para asegurar la integridad de los datos
      await dbClient.query('BEGIN');

      // 2. Insertar la cabecera en la tabla 'mensajes'
      const insertMensajeQuery = 'INSERT INTO mensajes (rgt_id, status) VALUES ($1, $2) RETURNING msg_id';
      const mensajeRes = await dbClient.query(insertMensajeQuery, [rgt_id, 1]); // Status 1 = Procesado
      const msg_id = mensajeRes.rows[0].msg_id;

      // 3. Insertar cada parámetro del mensaje en 'parametros_mensajes'
      const parametrosRecibidos = data.parametros;
      for (const nombreParametro in parametrosRecibidos) {
        const valorParametro = parametrosRecibidos[nombreParametro];

        // Buscar el ID del parámetro por su nombre (ej: "temperatura")
        const paramRes = await dbClient.query('SELECT prt_id FROM parametros WHERE nombre = $1', [nombreParametro]);
        if (paramRes.rows.length > 0) {
          const prt_id = paramRes.rows[0].prt_id;
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

// Iniciar el listener de MQTT una sola vez cuando arranca la aplicación
procesarMensajesMqtt();

// ===================================================================================
// INICIAR EL SERVIDOR EXPRESS
// ===================================================================================
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Servidor API escuchando en http://localhost:${PORT}`);
});