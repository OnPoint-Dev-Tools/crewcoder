import { App } from "../components/App.js";
import { readGitLabel } from "../state/git-status.js";
import { createInitialState } from "../state/tui-store.js";
import { loadCrewCoderTheme } from "../theme/theme.js";
import { InputRouter } from "./input.js";
import { OverlayManager } from "./overlay.js";
import { Renderer } from "./renderer.js";
import { readCrewCoderRemoteConnection } from "../bridge/remote-connection.js";

export class CrewCoderTui {
  private readonly state: ReturnType<typeof createInitialState>;
  private readonly app: App;
  private readonly overlays: OverlayManager;
  private readonly renderer: Renderer;
  private readonly input = new InputRouter();
  private renderTimer: NodeJS.Timeout | undefined;

  constructor(themeSelector?: string) {
    this.state = createInitialState();
    const remote = readCrewCoderRemoteConnection();
    if (remote) {
      this.state.cwd = remote.cwd;
      this.state.remoteTarget = remote.target;
    } else {
      this.state.gitLabel = readGitLabel(this.state.cwd);
    }
    this.app = new App(this.state);
    this.overlays = new OverlayManager(this.app);
    this.renderer = new Renderer(this.overlays, loadCrewCoderTheme(themeSelector));
    this.app.pushOverlay = (component, options) => this.overlays.push(component, options);
    this.app.closeOverlay = () => this.overlays.pop();
    this.app.repaint = () => this.renderer.render(true);
  }

  start(): void {
    this.renderer.start();
    void this.app.initialize();
    this.input.start();
    this.input.onInput((event) => { this.overlays.handleInput?.(event); this.renderer.render(); });
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
    process.stdout.on("resize", () => this.renderer.render(true));
    this.renderTimer = setInterval(() => this.renderer.render(), 120);
  }

  stop(): void {
    this.app.stop();
    if (this.renderTimer) clearInterval(this.renderTimer);
    this.input.stop();
    this.renderer.stop();
    process.exit(0);
  }
}
