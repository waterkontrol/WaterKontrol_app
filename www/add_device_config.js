// URL de tu API de Node.js en Railway (Debe ser la URL que usas en el .env)
const RAILWAY_API_URL = "https://waterkontrolapp-production.up.railway.app"; 

// Asignar listeners
document.getElementById('config-form').addEventListener('submit', sendCredentialsToDevice);

const messageElement = document.getElementById('messageElement');

// 1. Función para enviar credenciales al dispositivo (Asumiendo que el dispositivo está en modo AP en 192.168.4.1)
async function sendCredentialsToDevice(e) {
    e.preventDefault();
    document.getElementById('submitButton').disabled = true;
    showMessage("info", "Enviando credenciales al dispositivo...", "blue");

    const ssid = document.getElementById('ssid').value;
    const password = document.getElementById('password').value;

    try {
        // A) ENVIAR CONFIGURACIÓN AL DISPOSITIVO ESP32 (Lógica Local, IP Fija)
        // NOTA: 192.168.4.1 es la IP por defecto de un ESP32/ESP8266 cuando está en modo AP.
        const response = await fetch('http://192.168.4.1/config', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                wifi_ssid: ssid, 
                wifi_pass: password, 
                // Enviar la URL de tu broker MQTT de Railway/Configuración
                mqtt_broker: RAILWAY_API_URL, // Debería ser el broker MQTT, no la API URL. ¡CORREGIR ESTO!
                mqtt_topic: 'dispositivos/nuevo/telemetria' 
            })
        });

        if (!response.ok) {
            // Este error se lanza si el ESP32 devuelve un status 4xx/5xx
            throw new Error(`Error en la configuración local del dispositivo (Status: ${response.status}).`);
        }
        
        // El dispositivo aceptó la configuración, ahora intentará conectarse a la red doméstica y al broker.
        showMessage("success", 
            "✅ Configuración enviada. El dispositivo se está conectando a tu Wi-Fi. Ahora, reconecta tu teléfono a tu red Wi-Fi doméstica.", 
            "green");
        
        // B) REGISTRAR EL DISPOSITIVO EN TU API DE RAILWAY (Lógica conceptual)
        // Esta parte es conceptual y necesitará un ID de dispositivo real devuelto por el ESP32.
        /*
        const registerResponse = await fetch(`${RAILWAY_API_URL}/dispositivo`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ 
                 usr_id: 'OBTENER_DE_SESION', // NECESITA TOKEN/COOKIE DEL USUARIO
                 dsp_id: 'ID_NUEVO_DISPOSITIVO', // ID REAL DEL ESP32
                 topic: 'dispositivos/nuevo/telemetria' 
             })
        });

        if (registerResponse.ok) {
             showMessage("success", 
                "✅ Dispositivo configurado y registrado en la plataforma. Redirigiendo...", 
                "green");
        } else {
             showMessage("warning", 
                "⚠️ Configurado localmente, pero falló el registro en la plataforma.", 
                "orange");
        }
        */

        // Opcional: Redirigir después de unos segundos
        setTimeout(() => {
            window.location.href = '/app.html';
        }, 8000); 

    } catch (error) {
        // Este error es muy común si la IP no es accesible (no conectado al AP del dispositivo)
        showMessage("error", 
            `❌ Error de conexión: ${error.message}. Asegúrate de que tu celular/PC esté **conectado a la red Wi-Fi temporal del dispositivo** (ej: WaterKontrol-AP) para enviar las credenciales.`, 
            "red");
    }
    document.getElementById('submitButton').disabled = false;
}

function showMessage(type, content, color) {
    messageElement.style.display = 'block';
    messageElement.className = `message ${type}`;
    messageElement.textContent = content;
    if (color) {
         messageElement.style.backgroundColor = color; // Usar background-color para los estilos de fondo
         messageElement.style.color = 'white'; // Asegurar texto blanco para fondo oscuro
    }
}
// NOTA CRÍTICA: Se omite la lógica de escaneo (scanWifi) porque depende de un plugin Cordova/Capacitor nativo.
