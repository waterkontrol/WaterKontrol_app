const RAILWAY_API_URL = 'https://waterkontrolapp-production.up.railway.app';

const configForm = document.getElementById('config-form');
const scanButton = document.getElementById('scan-wifi-btn');
const submitButton = document.getElementById('submitButton');
const messageElement = document.getElementById('message');
const ssidSelect = document.getElementById('ssid');
const manualSsidInput = document.getElementById('manual-ssid');

scanButton.addEventListener('click', scanWifi);
configForm.addEventListener('submit', sendCredentialsToDevice);

const deviceDataMap = {
  "WKM-0001": { modelo: "Medidor pH/Temp", tipo: "Medidor", marca: "WaterKontrol" },
  "WKM-0002": { modelo: "Controlador Bomba", tipo: "Actuador", marca: "WaterKontrol" }
};

async function scanWifi() {
  ssidSelect.innerHTML = '<option value="">-- Selecciona una Red --</option>';
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
        showMessage("success", `✅ Escaneo completado. ${networks.length} redes encontradas.`, "green");
        scanButton.disabled = false;
      },
      (error) => {
        showMessage("error", `❌ Error en el escaneo Wi-Fi: ${error}. ¿Tienes permisos de ubicación activados?`, "red");
        scanButton.disabled = false;
      }
    );
  } else {
    showMessage("info", "Esta función requiere la aplicación Android (APK). Simulando redes...", "blue");
    setTimeout(() => {
      const simulatedNetworks = ["Home_WiFi", "Guest_WiFi", "WaterKontrol-AP"];
      simulatedNetworks.forEach(network => {
        const option = document.createElement('option');
        option.value = network;
        option.textContent = network;
        ssidSelect.appendChild(option);
      });
      showMessage("success", "✅ Simulación de escaneo completada.", "green");
      scanButton.disabled = false;
    }, 1500);
  }
}

async function sendCredentialsToDevice(e) {
  e.preventDefault();
  submitButton.disabled = true;

  const ssid = ssidSelect.value || manualSsidInput.value;
  const password = document.getElementById('password').value;
  const serie = document.getElementById('serie').value.toUpperCase().trim();

  if (!ssid || !password || !serie) {
    showMessage("error", "❌ Por favor, completa todos los campos.", "red");
    submitButton.disabled = false;
    return;
  }

  const deviceData = deviceDataMap[serie] || { modelo: 'Modelo Desconocido', tipo: 'Genérico', marca: 'N/A' };
  const topic = `dispositivos/${serie}/telemetria`;

  showMessage("info", "📡 Enviando credenciales Wi-Fi al dispositivo...", "blue");

  try {
    const response = await fetch('http://192.168.4.1/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wifi_ssid: ssid,
        wifi_pass: password,
        mqtt_broker: RAILWAY_API_URL.replace('https://', 'mqtts://').replace('http://', 'mqtt://'),
        mqtt_topic: topic
      })
    });

    if (!response.ok) {
      showMessage("error", `❌ Error en la API local del dispositivo (Status: ${response.status}).`, "red");
      submitButton.disabled = false;
      return;
    }

    showMessage("info", "✅ Credenciales aceptadas. Registrando en la plataforma...", "blue");

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
    showMessage("error", `❌ Error de conexión: ${error.message}. Asegúrate de estar conectado al Wi-Fi del dispositivo.`, "red");
  }

  submitButton.disabled = false;
}

function showMessage(type, content, color) {
  messageElement.style.display = 'block';
  messageElement.className = `message ${type}`;
  messageElement.textContent = content;
  if (color) messageElement.style.color = color;
}