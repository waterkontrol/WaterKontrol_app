const RAILWAY_API_URL = 'https://waterkontrolapp-production.up.railway.app';

const configForm = document.getElementById('config-form');
const scanButton = document.getElementById('scan-wifi-btn');
const submitButton = document.getElementById('submitButton');
const messageElement = document.getElementById('message');
const ssidSelect = document.getElementById('ssid');
const manualSsidInput = document.getElementById('manual-ssid');

scanButton.addEventListener('click', scanWifi);
configForm.addEventListener('submit', sendCredentialsToDevice);

// Mapeo de números de serie a datos del dispositivo (ajustar según tus dispositivos)
const deviceDataMap = {
  "WKM-0001": { modelo: "Medidor pH/Temp", tipo: "Medidor", marca: "WaterKontrol" },
  "WKM-0002": { modelo: "Controlador Bomba", tipo: "Actuador", marca: "WaterKontrol" }
};

// =================================================================
// 1. FUNCIÓN PARA ESCANEAR REDES WI-FI
// =================================================================
async function scanWifi() {
  ssidSelect.innerHTML = '<option value="">-- Selecciona una Red --</option>';
  showMessage("info", "📶 Escaneando redes Wi-Fi... (Esta función requiere la app nativa para Android)", "blue");
  scanButton.disabled = true;

  // Lógica para entorno nativo (usando el plugin Hotspot)
  if (window.plugins && window.plugins.Hotspot) {
    window.plugins.Hotspot.scanWifi(
      (networks) => { // Función de éxito
        networks.forEach(network => {
          const option = document.createElement('option');
          // El plugin puede devolver SSID o ssid, usamos ambos por seguridad
          option.value = network.SSID || network.ssid; 
          option.textContent = network.SSID || network.ssid;
          ssidSelect.appendChild(option);
        });
        showMessage("success", `✅ Se encontraron ${networks.length} redes.`, "green");
        scanButton.disabled = false;
      },
      (error) => { // Función de error
        showMessage("error", `❌ Error al escanear redes: ${error}`, "red");
        scanButton.disabled = false;
      }
    );
  } else {
    // Datos de prueba (Mock data) para probar en el navegador
    setTimeout(() => {
      const mockNetworks = [
        { SSID: "Mi_WiFi_Hogar", ssid: "Mi_WiFi_Hogar" },
        { SSID: "Red_Vecino", ssid: "Red_Vecino" },
        { SSID: "WaterKontrol-AP", ssid: "WaterKontrol-AP" } // AP del dispositivo
      ];
      mockNetworks.forEach(network => {
        const option = document.createElement('option');
        option.value = network.SSID || network.ssid;
        option.textContent = network.SSID || network.ssid;
        ssidSelect.appendChild(option);
      });
      showMessage("warning", `⚠️ Usando datos de prueba. Se encontraron ${mockNetworks.length} redes.`, "orange");
      scanButton.disabled = false;
    }, 1500);
  }
}

// =================================================================
// 2. FUNCIÓN PARA ENVIAR CREDENCIALES
// =================================================================
async function sendCredentialsToDevice(e) {
  e.preventDefault();
  submitButton.disabled = true;

  const selectedSsid = ssidSelect.value;
  const manualSsid = manualSsidInput.value.trim();
  // El SSID a usar es el manual si se llenó, si no, el del select.
  const ssid = manualSsid || selectedSsid; 
  const password = document.getElementById('password').value;
  const serie = document.getElementById('serie').value.toUpperCase().trim();

  if (!ssid || !password || !serie) {
    showMessage("error", "Todos los campos son obligatorios.", "red");
    submitButton.disabled = false;
    return;
  }

  // Verificar que el número de serie sea conocido
  const deviceData = deviceDataMap[serie];
  if (!deviceData) {
    showMessage("error", `❌ Número de serie desconocido: ${serie}. Por favor, verifica el número.`, "red");
    submitButton.disabled = false;
    return;
  }
  
  // Generar el topic MQTT dinámicamente con la serie
  const topic = `dispositivos/${serie}/telemetria`; 

  showMessage("info", "➡️ Enviando credenciales al dispositivo...", "blue");

  try {
    // A) CONFIGURAR EL DISPOSITIVO (Paso 1: Comunicación local con el ESP32)
    // CRÍTICO: 192.168.4.1 es la IP por defecto del dispositivo en modo AP.
    const response = await fetch('http://192.168.4.1/config', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            wifi_ssid: ssid, 
            wifi_pass: password, 
            // Se envía la URL completa de Railway y el topic dinámico
            mqtt_broker: RAILWAY_API_URL, 
            mqtt_topic: topic 
        })
    });

    if (!response.ok) {
      // Si la respuesta del ESP32 no es OK, es un error local
      showMessage("error", `❌ Error en la API local del dispositivo (Status: ${response.status}).`, "red");
      submitButton.disabled = false;
      return;
    }

    showMessage("info", "✅ Credenciales aceptadas. Registrando en la plataforma...", "blue");

    // B) REGISTRAR EL DISPOSITIVO EN TU API DE RAILWAY (Paso 2: Comunicación con el backend)
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
      // Redirigir a la página principal tras un registro exitoso
      setTimeout(() => window.location.href = '/app.html', 2000); 
    } else {
      // Manejar error de registro en la plataforma
      const errorData = await registerResponse.json().catch(() => ({ message: 'Error desconocido' }));
      showMessage("error", `❌ Error al registrar en la plataforma: ${errorData.message}`, "red");
    }
  } catch (error) {
    // Este error es común si el celular/PC no está conectado al Wi-Fi del dispositivo
    showMessage("error", `❌ Error de conexión: ${error.message}. Asegúrate de estar conectado al Wi-Fi del dispositivo.`, "red");
  }

  submitButton.disabled = false;
}

// Función de utilidad para mostrar mensajes en el DOM (reusa las clases de style.css)
function showMessage(type, content, color) {
    messageElement.style.display = 'block';
    messageElement.className = `message ${type}`;
    messageElement.textContent = content;
    if (color) {
        // Estilos custom para tipos 'info' y 'warning' que no tienen clase CSS propia.
        if (type === 'info') {
            messageElement.style.backgroundColor = '#cce5ff'; // Azul Claro
            messageElement.style.color = '#004085'; // Azul Oscuro
        } else if (type === 'warning') {
            messageElement.style.backgroundColor = '#fff3cd'; // Amarillo Claro
            messageElement.style.color = '#856404'; // Amarillo Oscuro
        } else {
            // Limpiar estilos si se usa una clase de CSS como 'success' o 'error'
            messageElement.style.backgroundColor = ''; 
            messageElement.style.color = '';
        }
    }
}