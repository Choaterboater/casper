import { useState, type FormEvent } from 'react'
import './App.css'

function App() {
  const [notes, setNotes] = useState<string[]>([])
  const [error, setError] = useState('')

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const note = String(new FormData(form).get('note') ?? '').trim()
    if (!note) {
      setError('Write something first.')
      return
    }
    setNotes((current) => [...current, note])
    setError('')
    form.reset()
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>{{name}}</h1>
        <p className="muted">
          Edit <code>src/App.tsx</code> and save; the page updates. Colors, type
          and spacing live in <code>src/theme.css</code>.
        </p>
      </header>

      <main className="notes">
        <h2>Notes</h2>
        <form className="add-form" onSubmit={add} noValidate>
          <div className="field">
            <label htmlFor="note">New note</label>
            <input
              id="note"
              name="note"
              type="text"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'note-error' : undefined}
            />
          </div>
          <button type="submit">Add</button>
        </form>
        {error && (
          <p id="note-error" role="alert" className="error">
            {error}
          </p>
        )}
        {notes.length === 0 ? (
          <p className="muted">No notes yet. Add one above.</p>
        ) : (
          <ul className="list">
            {notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

export default App
