/** Rendered components are plain strings: no framework runtime is installed here. */
export type Props = Readonly<Record<string, string>>;

export interface Component {
  readonly name: string;
  render(props: Props): string;
}

export const button: Component = {
  name: "Button",
  render: (props) => `<button class="btn">${props.label ?? ""}</button>`,
};

export const badge: Component = {
  name: "Badge",
  render: (props) => `<span class="badge">${props.label ?? ""}</span>`,
};

/** Registry order is the render order. */
export const components: readonly Component[] = [button, badge];

export function findComponent(name: string): Component | undefined {
  return components.find((component) => component.name === name);
}
