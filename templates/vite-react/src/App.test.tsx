/// <reference types="bun" />
import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import App from './App'

let root: Root | undefined

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
})

function render(): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<App />))
  return container
}

test('the page shows its heading', () => {
  const page = render()
  expect(page.querySelector('h1')?.textContent).toBe('{{name}}')
})

test('the note field has a label', () => {
  const page = render()
  const input = page.querySelector('input')!
  expect(page.querySelector(`label[for="${input.id}"]`)?.textContent).toBe('New note')
})

test('with no notes, the list says so', () => {
  const page = render()
  expect(page.textContent).toContain('No notes yet')
})
