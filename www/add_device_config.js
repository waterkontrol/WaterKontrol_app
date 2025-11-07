// Importa las funciones de Capacitor.
// NOTA: El plugin Hotspot es de Cordova, por lo que usaremos window.plugins.Hotspot
const RAILWAY_API_URL = 'https://waterkontrolapp-production.up.railway.app';

const configForm = document.getElementById('config-form');
const scanButton = document.getElementById('scan-wifi-btn');
const submitButton = document.getElementById('submitButton');
const messageElement = document.getElementById('message');
const ssidSelect = document.getElementById('ssid');
const manualSsidInput = document.getElementById('manual-ssid');

scanButton.addEventListener('click', scanWifi);
configForm.addEventListener('submit', sendCredentialsToDevice);

// Datos simulados para asociar al número de serie
const deviceDataMap = {
  "WKM-0001": { modelo: "Medidor pH/Temp", tipo: "Medidor", marca: "WaterKontrol" },
  "WKM-0002": { modelo: "Controlador Bomba", tipo: "Actuador", marca: "WaterKontrol" }
};

// ... (Función scanWifi existente) ...
async function scanWifi() {
  ssidSelect.innerHTML = '<option value=\"\">-- Selecciona una Red --</option>';
  showMessage("info", "📶 Escaneando redes Wi-Fi... (Esta función requiere la app nativa para Android)", "blue");
  scanButton.disabled = true;

  if (window.plugins && window.plugins.Hotspot) {
    window.plugins.Hotspot.scanWifi(
      (networks) => {
        networks.forEach(network => {
          const option = document.createElement('option');
          option.value = network.SSID || network.ssid;
          option.textContent = network.SSID || network.ssid;
          ssidSelect.appendChild(option);
        });
        showMessage("success", `✅ Se encontraron ${networks.length} redes.`, "green");
        scanButton.disabled = false;
      },
      (error) => {
        showMessage("error", `❌ Error al escanear Wi-Fi: ${error}`, "red");
        scanButton.disabled = false;
      }
    );
  } else {
    showMessage("error", "⚠️ Plugin Hotspot no disponible. Asegúrate de estar en el APK de Android.", "red");
    scanButton.disabled = false;
  }
}

async function sendCredentialsToDevice(e) {
  e.preventDefault();
  submitButton.disabled = true;

  const ssid = manualSsidInput.value.trim() || ssidSelect.value;
  const password = document.getElementById('password').value;
  const serie = document.getElementById('serie').value.trim().toUpperCase();

  if (!ssid || !password || !serie) {
    showMessage("error", "Faltan campos (SSID, Contraseña o Serie).", "red");
    submitButton.disabled = false;
    return;
  }

  const deviceData = deviceDataMap[serie];
  if (!deviceData) {
    showMessage("error", `El Número de Serie ${serie} no es válido.`, "red");
    submitButton.disabled = false;
    return;
  }
  
  const topic = `waterkontrol/${serie}/telemetria`;

  try {
    showMessage("info", "⏳ 1/2: Enviando credenciales al dispositivo (192.168.4.1)...", "blue");
    
    // A) CONFIGURACIÓN LOCAL DEL DISPOSITIVO (ESP32/ESP8266)
    // 192.168.4.1 es la IP por defecto de un ESP32/ESP8266 cuando está en modo AP.
    const response = await fetch('http://192.168.4.1/config', { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        wifi_ssid: ssid, 
        wifi_pass: password, 
        // 💡 CRÍTICO: Usar la URL base de tu API, no el broker
        mqtt_broker: RAILWAY_API_URL, 
        mqtt_topic: topic 
      })
    });

    if (!response.ok) {
      showMessage("error", `❌ Error en la API local del dispositivo (Status: ${response.status}). Asegúrate de estar conectado al AP.`, "red");
      submitButton.disabled = false;
      return;
    }

    showMessage("info", "✅ Credenciales aceptadas. ⏳ 2/2: Registrando en la plataforma...", "blue");

    // B) REGISTRAR EL DISPOSITIVO EN TU API DE RAILWAY
    // El servidor (index.js) obtendrá el usr_id de la cookie de sesión automáticamente.
    const registerResponse = await fetch(`${RAILWAY_API_URL}/api/dispositivo/registro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serie: serie,
        modelo: deviceData.modelo,
        tipo: deviceData.tipo,
        marca: deviceData.marca,
        topic: topic
      })
    });

    if (registerResponse.ok) {
      showMessage("success", "🎉 ¡Dispositivo configurado y registrado! Redirigiendo...", "green");
      setTimeout(() => window.location.href = '/app.html', 2000);
    } else {
      const errorData = await registerResponse.json().catch(() => ({ message: 'Error desconocido' }));
      showMessage("error", `❌ Error al registrar en la plataforma: ${errorData.message}`, "red");
    }
  } catch (error) {
    // Error si el fetch a 192.168.4.1 falla, indicando que no está conectado al AP.
    showMessage("error", `❌ Error de conexión: ${error.message}. Asegúrate de que tu celular esté **conectado a la red Wi-Fi temporal del dispositivo (WaterKontrol-AP)** para enviar las credenciales.`, "red");
  }

  submitButton.disabled = false;
}

function showMessage(type, content, color) {
  messageElement.style.display = 'block';
  messageElement.className = `message ${type}`;
  messageElement.textContent = content;
  if (color) {
    messageElement.style.color = color;
  }
}