let socket;
let reconnectTimer;
let heartbeatTimer;
let isInternalUpdate = false;

const listeners = new Set();

export function initSync(baseURL) {
    if (socket) return;

    function connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${window.location.host}${baseURL}/api/sync`;
        
        socket = new WebSocket(url);

        socket.onopen = () => {
            clearTimeout(reconnectTimer);
            startHeartbeat();
        };

        socket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (localStorage.getItem(data.key) !== data.value) {
                isInternalUpdate = true;
                localStorage.setItem(data.key, data.value);
                isInternalUpdate = false;
                
                // Notify all listeners
                listeners.forEach(callback => callback(data.key));
            }
        };

        socket.onclose = () => {
            stopHeartbeat();
            reconnectTimer = setTimeout(connect, 3000);
        };
    }

    function startHeartbeat() {
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'ping' }));
            }
        }, 30000);
    }

    function stopHeartbeat() {
        clearInterval(heartbeatTimer);
    }

    connect();
}

export function subscribe(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
}

export function broadcast(key, value) {
    if (!isInternalUpdate && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ key, value }));
    }
}
