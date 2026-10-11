import { useState } from "react";

const CONDITIONS = ["Mint", "Near mint", "Played", "Damaged"];

export default function App() {
  const [cards, setCards] = useState([]);
  const [form, setForm] = useState({ name: "", set: "", condition: CONDITIONS[0], value: "" });

  function add(event) {
    event.preventDefault();
    setCards([...cards, { ...form, id: Date.now(), value: Number(form.value) || 0 }]);
    setForm({ ...form, name: "", value: "" });
  }

  const total = cards.reduce((sum, card) => sum + card.value, 0);

  return (
    <main>
      <h1>Card Binder</h1>
      <form onSubmit={add}>
        <input placeholder="Card name" value={form.name} required onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="Set" value={form.set} required onChange={(e) => setForm({ ...form, set: e.target.value })} />
        <select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })}>
          {CONDITIONS.map((condition) => <option key={condition}>{condition}</option>)}
        </select>
        <input placeholder="Value ($)" type="number" min="0" step="0.01" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
        <button type="submit">Add card</button>
      </form>
      <table>
        <thead>
          <tr><th>Name</th><th>Set</th><th>Condition</th><th>Value</th><th></th></tr>
        </thead>
        <tbody>
          {cards.map((card) => (
            <tr key={card.id}>
              <td>{card.name}</td>
              <td>{card.set}</td>
              <td>{card.condition}</td>
              <td>${card.value.toFixed(2)}</td>
              <td><button onClick={() => setCards(cards.filter((other) => other.id !== card.id))}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>{cards.length} cards · total value ${total.toFixed(2)}</p>
    </main>
  );
}
