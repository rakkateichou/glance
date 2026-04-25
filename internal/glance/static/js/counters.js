import { elem, fragment } from "./templating.js";
import { throttledDebounce } from "./utils.js";
import { subscribe, broadcast } from "./sync.js";

export default function(element) {
    const { widgetId: id } = element.dataset;
    const labels = Array.from(element.querySelectorAll('.counter-row')).map(row => row.dataset.label);
    
    element.innerHTML = '';
    element.append(Counters(id, labels));
}

function Counters(id, labels) {
    const container = elem("div").classes("counters-list");
    const storageKey = `counters-${id}`;

    const loadData = () => JSON.parse(localStorage.getItem(storageKey) || "{}");
    const saveData = (data) => {
        const value = JSON.stringify(data);
        localStorage.setItem(storageKey, value);
        broadcast(storageKey, value);
    };

    const counters = {};
    const data = loadData();

    const updateValue = (label, delta) => {
        const currentData = loadData();
        currentData[label] = (currentData[label] || 0) + delta;
        if (currentData[label] < 0) currentData[label] = 0;
        saveData(currentData);
        counters[label].component.setValue(currentData[label]);
    };

    labels.forEach(label => {
        const row = CounterRow(label, data[label] || 0, (delta) => updateValue(label, delta));
        counters[label] = row;
        container.append(row);
    });

    const unsubscribe = subscribe((key) => {
        if (key === storageKey) {
            const freshData = loadData();
            labels.forEach(label => {
                counters[label].component.setValue(freshData[label] || 0);
            });
        }
    });

    return container;
}

function CounterRow(label, initialValue, onUpdate) {
    let valueDisplay;
    const row = elem("div").classes("counter-row-item", "flex", "items-center", "gap-10", "margin-bottom-10").append(
        elem("div").classes("counter-label", "grow").text(label),
        elem("button").classes("counter-btn", "btn-minus").text("-").on("click", () => onUpdate(-1)),
        valueDisplay = elem("div").classes("counter-value").styles({ minWidth: "2rem", textAlign: "center" }).text(initialValue),
        elem("button").classes("counter-btn", "btn-plus").text("+").on("click", () => onUpdate(1))
    );

    return row.component({
        setValue: (val) => valueDisplay.text(val)
    });
}
