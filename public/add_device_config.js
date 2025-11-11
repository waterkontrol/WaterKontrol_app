const RAILWAY_API_URL = 'https://waterkontrolapp-production.up.railway.app';

const configForm = document.getElementById('config-form');
const submitButton = document.getElementById('submitButton');
const messageElement = document.getElementById('messageElement');

configForm.addEventListener('submit', sendCredentialsToDevice);

async function sendCredentialsToDevice(e) {
  e.preventDefault();
  submitButton.disabled = true;

  const ssid = document.getElementById('ssid').value.trim();
  const password = document.getElementById('password').value.trim();
  const serie = document.getElementById('serie').value.toUpperCase().trim();
  const device_name = document.getElementById('device_name').value.trim();
  const device_type = document.getElementById('device_type').value.trim();
  const device_brand = document.getElementById('device_brand').value.trim() || 'WaterKontrol';

  if (!ssid || !password || !serie || !device_name || !device_type) {
    showMessage('error', 'Todos los campos son obligatorios.', 'red');
    submitButton.disabled = false;
    return;
  }

  const topic = `dispositivos/${serie}/telemetria`;

  showMessage('info', '➡️ Enviando credenciales al dispositivo...', 'blue');

  try {
    const response = await fetch('http://192.168.4.1/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wifi_ssid: ssid, wifi_pass: password, mqtt_broker: RAILWAY_API_URL, mqtt_topic: topic })
    });

    if (!response.ok) {
      showMessage('error', `❌ Error en la API local del dispositivo (Status: ${response.status}).`, 'red');
      submitButton.disabled = false;
      return;
    }

    showMessage('info', '✅ Credenciales aceptadas. Registrando en la plataforma...', 'blue');

    const registerResponse = await fetch(`${RAILWAY_API_URL}/api/dispositivo/registro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // ← Enviar cookies
      body: JSON.stringify({ serie, modelo: device_name, tipo: device_type, marca: device_brand, topic })
    });

    if (registerResponse.ok) {
      showMessage('success', '🎉 ¡Dispositivo configurado y registrado! Redirigiendo...', 'green');
      setTimeout(() => window.location.href = '/app.html', 2000);
    } else {
      const errorData = await registerResponse.json().catch(() => ({ message: 'Error desconocido' }));
      showMessage('error', `❌ Error al registrar en la plataforma: ${errorData.message}`, 'red');
    }
  } catch (error) {
    showMessage('error', `❌ Error de conexión: ${error.message}. Asegúrate de estar conectado al Wi-Fi del dispositivo.`, 'red');
  }

  submitButton.disabled = false;
}

function showMessage(type, content, color) {
  messageElement.style.display = 'block';
  messageElement.textContent = content;
  messageElement.style.color = color;
}