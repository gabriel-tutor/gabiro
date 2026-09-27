/** True inside the Gabiro Mac app, whose windows add "Gabiro/<version>" to the user agent. */
export const inGabiroApp = () => navigator.userAgent.includes("Gabiro/");

/** Header link back to the app's start window; the app intercepts gabiro:// navigation. Hidden in browsers. */
export function SwitchProject() {
  if (!inGabiroApp()) return null;
  return (
    <a href="gabiro://start" className="gb-switch">
      Switch project
    </a>
  );
}
