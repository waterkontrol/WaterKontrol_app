// URL de tu API de Node.js en Railway
const RAILWAY_API_URL = "https://waterkontrolapp-production.up.railway.app"; // Asegúrate de que sea la correcta

// Asignar listeners
document.getElementById('config-form').addEventListener('submit', sendCredentialsToDevice);
const messageElement = document.getElementById('messageElement');

// 1. Función para enviar credenciales al dispositivo (Asumiendo que el dispositivo está en modo AP en 192.168.4.1)
async function sendCredentialsToDevice(e) {
    e.preventDefault();
    const submitButton = document.getElementById('submitButton');
    submitButton.disabled = true;
    showMessage("info", "Enviando credenciales al dispositivo...", "#007bff");

    const ssid = document.getElementById('ssid').value;
    const password = document.getElementById('password').value;
    const device_name = document.getElementById('device_name').value;
    const device_type = document.getElementById('device_type').value;
    const device_brand = document.getElementById('device_brand').value;
    // Generar un topic único para el dispositivo (esto debería hacerse de forma más robusta)
    const unique_id = Math.random().toString(36).substring(2, 10); // ID temporal simple
    const topic = `dispositivos/${unique_id}/telemetria`;

    try {
        // A) ENVIAR CONFIGURACIÓN AL DISPOSITIVO ESP32 (Lógica Local, IP Fija)
        // NOTA: 192.168.4.1 es la IP por defecto de un ESP32/ESP8266 cuando está en modo AP.
        const deviceResponse = await fetch('http://192.168.4.1/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                wifi_ssid: ssid,
                wifi_pass: password,
                // Enviar la URL real del broker MQTT, no la API URL
                mqtt_broker: process.env.MQTT_BROKER_URL || "mqtt://broker.emqx.io/", // CORREGIDO: Debe ser la URL del broker MQTT
                mqtt_topic: topic
            })
        });

        if (!deviceResponse.ok) {
            // Este error se lanza si el ESP32 devuelve un status 4xx/5xx
            throw new Error(`Error en la configuración local del dispositivo (Status: ${deviceResponse.status}).`);
        }

        // El dispositivo aceptó la configuración, ahora intentará conectarse a la red doméstica y al broker.
        showMessage("success", "✅ Configuración enviada al dispositivo. Intentando registrar en la plataforma...", "#28a745");

        // B) REGISTRAR EL DISPOSITIVO EN TU API DE RAILWAY
        // NOTA: Aquí es donde se debe enviar el usr_id. Por ahora, se envía un usr_id falso (1).
        // ESTE ES EL PUNTO CRÍTICO: La obtención real del usr_id desde el frontend requiere un backend robusto.
        // Para este ejemplo, supondremos que el usr_id es 1 (ver index.js).
        const registerResponse = await fetch(`${RAILWAY_API_URL}/dispositivo`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({
                 // usr_id: 'OBTENER_DE_SESION', // <-- ESTO ES LO IDEAL PERO COMPLEJO SIN JWT/Sesiones
                 nombre: device_name,
                 tipo: device_type,
                 marca: device_brand || null,
                 topic: topic
             })
        });

        if (registerResponse.ok) {
             const registerData = await registerResponse.json();
             showMessage("success",
                `✅ Dispositivo "${registerData.nombre}" registrado en la plataforma con topic "${registerData.topic}". Redirigiendo...`,
                "#28a745");
             // Opcional: Redirigir después de unos segundos
             setTimeout(() => {
                 window.location.href = '/app.html';
             }, 3000);
        } else {
             const errorData = await registerResponse.json();
             showMessage("error",
                `❌ Error al registrar el dispositivo en la plataforma: ${errorData.message || 'Error desconocido'}`,
                "#dc3545");
        }

    } catch (error) {
        // Este error es muy común si la IP no es accesible (no conectado al AP del dispositivo)
        showMessage("error",
            `❌ Error de conexión: ${error.message}. Asegúrate de que tu celular/PC esté **conectado a la red Wi-Fi temporal del dispositivo** (ej: WaterKontrol-AP) para enviar las credenciales.`,
            "#dc3545");
    }
    submitButton.disabled = false;
}

function showMessage(type, content, bgColor) {
    messageElement.style.display = 'block';
    messageElement.textContent = content;
    messageElement.style.backgroundColor = bgColor;
    messageElement.style.color = 'white';
}