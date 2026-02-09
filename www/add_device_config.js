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
    showMessage('error', 'Todos los campos son obligatorios.');
    submitButton.disabled = false;
    return;
  }

  const topic = `dispositivos/${serie}/telemetria`;

  showMessage('info', 'Enviando credenciales al dispositivo...');

  try {
    const response = await fetch('http://192.168.4.1/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wifi_ssid: ssid, wifi_pass: password, mqtt_broker: RAILWAY_API_URL, mqtt_topic: topic })
    });

    if (!response.ok) {
      showMessage('error', `Error en la API local del dispositivo (Status: ${response.status}).`);
      submitButton.disabled = false;
      return;
    }

    showMessage('info', 'Credenciales aceptadas. Registrando en la plataforma...');

    const registerResponse = await fetch(`${RAILWAY_API_URL}/api/dispositivo/registro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('token') },
      body: JSON.stringify({ serie, modelo: device_name, tipo: device_type, marca: device_brand, topic })
    });

    if (registerResponse.ok) {
      showMessage('success', '¡Dispositivo configurado y registrado! Redirigiendo...');
      setTimeout(() => window.location.href = '/app.html', 2000);
    } else {
      if (registerResponse.status === 401) {
        showMessage('error', 'No autorizado. Por favor, inicia sesión.');
        setTimeout(() => window.location.href = '/login.html', 1500);
        return;
      }
      const errorData = await registerResponse.json().catch(() => ({ message: 'Error desconocido' }));
      showMessage('error', `Error al registrar en la plataforma: ${errorData.message}`);
    }
  } catch (error) {
    showMessage('error', `Error de conexión: ${error.message}. Asegúrate de estar conectado al Wi-Fi del dispositivo.`);
  }

  submitButton.disabled = false;
}

function showMessage(type, content) {
  messageElement.className = 'message show ' + type;
  messageElement.textContent = content;
}