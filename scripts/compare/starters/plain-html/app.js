const form = document.getElementById("add");
const list = document.getElementById("bottles");
const empty = document.getElementById("empty");
let bottles = JSON.parse(localStorage.getItem("bottles") || "[]");

function save() {
  localStorage.setItem("bottles", JSON.stringify(bottles));
}

function render() {
  list.innerHTML = "";
  for (const bottle of bottles) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${bottle.name} (${bottle.proof} proof)`;
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      bottles = bottles.filter((other) => other.id !== bottle.id);
      save();
      render();
    });
    item.append(label, remove);
    list.append(item);
  }
  empty.hidden = bottles.length > 0;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  bottles.push({ id: Date.now(), name: String(data.get("name")).trim(), proof: Number(data.get("proof")) });
  save();
  form.reset();
  render();
});

render();
