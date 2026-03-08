const priceEl = document.getElementById('calc-price');
const form = document.getElementById('calc-form');

const base = {
  classic: 38000,
  modern: 52000,
  double: 72000,
};

const material = {
  granite: 14000,
  marble: 11000,
  mix: 18000,
};

const fence = {
  none: 0,
  metal: 16000,
  stone: 28000,
};

const improve = {
  none: 0,
  tile: 24000,
  chip: 16000,
};

function formatPrice(value) {
  return `от ${value.toLocaleString('ru-RU')} ₽`;
}

function calc() {
  const data = new FormData(form);
  const length = parseFloat(data.get('length')) || 0;
  const width = parseFloat(data.get('width')) || 0;
  const areaFactor = Math.max(1, (length * width) / 3.6);

  let total = 0;
  total += base[data.get('monument')];
  total += material[data.get('material')];
  total += fence[data.get('fence')];
  total += improve[data.get('improve')];

  if (data.get('install')) {
    total += 12000;
  }

  if (data.get('delivery')) {
    total += 6000;
  }

  total = Math.round(total * areaFactor);
  priceEl.textContent = formatPrice(total);
}

form.addEventListener('change', calc);
form.addEventListener('input', calc);
calc();

