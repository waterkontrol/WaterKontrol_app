// Este script se ejecuta en add_device.html

// Importa las funciones de Capacitor.
// NOTA: El plugin Hotspot es de Cordova, por lo que usaremos window.plugins.Hotspot
// Este es un ejemplo conceptual basado en una API común de plugins.
// const { Wifi } = Capacitor.Plugins; // Mantener esta línea por si la usas en otro lado

// URL de tu API de Node.js en Railway (Reemplaza con tu URL real de Railway)
const RAILWAY_API_URL = "https://waterkontrolapp-production.up.railway.app"; 

const configForm = document.getElementById('config-form');
const scanButton = document.getElementById('scan-wifi-btn');
const submitButton = document.getElementById('submitButton');
const messageElement = document.getElementById('message');
const ssidSelect = document.getElementById('ssid');
const manualSsidInput = document.getElementById('manual-ssid');


scanButton.addEventListener('click', scanWifi);
configForm.addEventListener('submit', sendCredentialsToDevice);

// Mapeo conceptual de modelos de dispositivos y sus datos
const deviceDataMap = {
    // Para simplificar, asumimos que todos son el mismo modelo por ahora.
    "WKM-0001": { modelo: "Medidor pH/Temp", tipo: "Medidor", marca: "WaterKontrol" }, 
    "WKM-0002": { modelo: "Controlador Bomba", tipo: "Actuador", marca: "WaterKontrol" }
};


// ===================================================================================
// LÓGICA DE ESCANEO (Conceptual, requiere plugin nativo como cordova-plugin-hotspot)
// ===================================================================================

// 1. Función para escanear redes Wi-Fi (Conceptual)
async function scanWifi() {
    ssidSelect.innerHTML = '<option value="">-- Selecciona una Red --</option>';
    showMessage("info", "📶 Escaneando redes Wi-Fi... (Esta función requiere la app nativa para Android)", "blue");
    scanButton.disabled = true;

    // 💡 Implementación conceptual usando el plugin Cordova Hotspot (asumido en package.json)
    if (window.plugins && window.plugins.Hotspot) {
        window.plugins.Hotspot.scanWifi(
            (networks) => { // Función de éxito
                ssidSelect.innerHTML = '<option value="">-- Selecciona una Red --</option>';
                networks.forEach(network => {
                    const option = document.createElement('option');
                    option.value = network.SSID || network.ssid; // Depende de la API del plugin
                    option.textContent = network.SSID || network.ssid;
                    ssidSelect.appendChild(option);
                });
                showMessage("success", `✅ Escaneo completado. ${networks.length} redes encontradas.`, "green");
                scanButton.disabled = false;
            },
            (error) => { // Función de error
                showMessage("error", `❌ Error en el escaneo Wi-Fi: ${error}. ¿Tienes permisos de ubicación activados?`, "red");
                scanButton.disabled = false;
            }
        );
    } else {
         // Simulación para Web/Testing
         showMessage("info", "Esta función requiere la aplicación Android (APK). Simulación de redes: Home_WiFi, Guest_WiFi, WaterKontrol-AP.", "blue");
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


// ===================================================================================
// LÓGICA DE ENVÍO DE CREDENCIALES
// ===================================================================================

// 2. Función para enviar las credenciales y registrar el dispositivo
async function sendCredentialsToDevice(e) {
    e.preventDefault();
    submitButton.disabled = true;

    // Obtener SSID del select o del input manual
    const ssid = ssidSelect.value || manualSsidInput.value;
    const password = document.getElementById('password').value;
    const serie = document.getElementById('serie').value.toUpperCase().trim();
    
    // Validaciones
    if (!ssid || !password || !serie) {
        showMessage("error", "❌ Por favor, completa todos los campos (Red, Contraseña y Serie).", "red");
        submitButton.disabled = false;
        return;
    }
    
    const deviceData = deviceDataMap[serie] || { modelo: 'Modelo Desconocido', tipo: 'Genérico', marca: 'N/A' };
    const topic = `dispositivos/${serie}/telemetria`;

    showMessage("info", 
        "📡 Enviando credenciales Wi-Fi al dispositivo (IP 192.168.4.1)... Asegúrate de estar conectado al Wi-Fi del dispositivo.", 
        "blue");

    try {
        // A) ENVIAR CREDENCIALES AL DISPOSITIVO (IP local del ESP32/ESP8266)
        // 192.168.4.1 es la IP por defecto de un ESP32/ESP8266 cuando está en modo AP.
        const response = await fetch('http://192.168.4.1/config', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                wifi_ssid: ssid, 
                wifi_pass: password, 
                mqtt_broker: RAILWAY_API_URL.replace('https://', 'mqtts://').replace('http://', 'mqtt://'), // Asegurar que el broker sea la URL adecuada
                mqtt_topic: topic 
            })
        });

        if (!response.ok) {
            // Error en la API local del dispositivo
             showMessage("error", 
                        `❌ Error en la API local del dispositivo (Status: ${response.status}). ¿Estás conectado al Wi-Fi WaterKontrol-AP?`, 
                        "red");
             submitButton.disabled = false;
             return; // Salir si falla la comunicación con el dispositivo
        }
        
        showMessage("info", 
            "✅ Credenciales aceptadas por el dispositivo. Registrando en la plataforma WaterKontrol...", 
            "blue");


        // B) REGISTRAR EL DISPOSITIVO EN TU API DE RAILWAY
        // El backend usará el 'session_id' de la cookie para obtener el usr_id.
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
            showMessage("success", 
                "🎉 ¡Dispositivo configurado y registrado en la plataforma WaterKontrol! Redirigiendo...", 
                "green");
            // Opcional: Redirigir después de unos segundos
            setTimeout(() => {
                window.location.href = '/app.html';
            }, 8000); 

        } else {
             // Si el registro falla en la API
             const errorData = await registerResponse.json().catch(() => ({ message: 'Error desconocido.' }));
             showMessage("error", 
                 `❌ Error al registrar en la plataforma (Status: ${registerResponse.status}): ${errorData.message || registerResponse.statusText}`, 
                 "red");
             
        }

    } catch (error) {
        // Este error es muy común si la IP no es accesible (no conectado al AP del dispositivo)
        showMessage("error", 
            `❌ Error de conexión: ${error.message}. Asegúrate de que tu celular/PC esté **conectado a la red Wi-Fi temporal del dispositivo** (ej: WaterKontrol-AP) para enviar las credenciales.`, 
            "red");
    }
    submitButton.disabled = false;
}

// ===================================================================================
// FUNCIÓN DE UTILIDAD
// ===================================================================================
function showMessage(type, content, color) {
    messageElement.style.display = 'block';
    messageElement.className = `message ${type}`;
    messageElement.textContent = content;
    if (color) {
         messageElement.style.color = color; // Para el estado "Enviando..."
    }
}