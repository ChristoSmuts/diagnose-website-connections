import type { ProbePhase, Report, ReportSummary, SiteWithSummary, Verdict } from '@dwc/contracts';
import { applyTheme, readStoredTheme, THEME_STORAGE_KEY, type ThemeChoice } from '@dwc/tokens';
import { sharedStyles, type ProgressStep } from '@dwc/ui';
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import '@dwc/ui';
import './report-view.js';
import { ApiError, api, streamDiagnostic } from './api-client.js';
import { runClientProbe } from './client-probe.js';

/** The probe phases, in order, with plain names for the progress list. */
const PHASES: { key: ProbePhase; label: string }[] = [
  { key: 'validating', label: 'Checking the address' },
  { key: 'dns', label: 'Finding the address' },
  { key: 'tcp', label: 'Opening a connection' },
  { key: 'tls', label: 'Securing the connection' },
  { key: 'http', label: 'Requesting the page' },
  { key: 'stability', label: 'Checking consistency' },
  { key: 'network', label: 'Identifying the host' },
  { key: 'client', label: 'Measuring your connection' },
  { key: 'analysing', label: 'Working out what it means' },
];

/** Remembers the collapsed sidebar between visits, alongside the theme choice. */
const SIDEBAR_STORAGE_KEY = 'dwc-sidebar-collapsed';

export class DwcApp extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: block;
        min-height: 100vh;
        min-height: 100dvh;
        background: var(--dwc-surface);
        /* The backdrop is painted behind everything via ::before below. */
        isolation: isolate;
      }

      /*
       * Ambient backdrop.
       *
       * Two very faint offset gradients rather than a flat fill, so the page has
       * some depth behind the content without any element needing a background of
       * its own. Fixed, so it stays put while the report scrolls — a scrolling
       * gradient reads as a moving object and is distracting.
       *
       * Purely decorative: pointer-events off, and it drops out for print.
       */
      :host::before {
        content: '';
        position: fixed;
        inset: 0;
        z-index: -1;
        pointer-events: none;
        background:
          radial-gradient(
            60rem 40rem at 12% -10%,
            color-mix(in oklab, var(--dwc-brand) 7%, transparent),
            transparent 60%
          ),
          radial-gradient(
            50rem 36rem at 92% 4%,
            color-mix(in oklab, var(--dwc-info) 6%, transparent),
            transparent 60%
          );
      }

      /* Mobile-first: single column, sidebar becomes an overlay drawer.
         Desktop gets a persistent sidebar. Same markup, no duplicated tree. */
      .shell {
        display: grid;
        grid-template-rows: auto 1fr;
        min-height: 100dvh;
      }

      header {
        position: sticky;
        top: 0;
        z-index: var(--dwc-z-sticky);
        display: flex;
        align-items: center;
        gap: var(--dwc-space-3);
        min-height: var(--dwc-header-height);
        box-sizing: border-box;
        padding: var(--dwc-space-3) var(--dwc-space-4);
        border-bottom: 1px solid var(--dwc-border);
        /* Translucent rather than opaque so content scrolling beneath is faintly
           visible — the bar reads as floating over the page, not capping it. */
        background: color-mix(in oklab, var(--dwc-surface) 78%, transparent);
        backdrop-filter: blur(14px) saturate(1.4);
      }

      .brand {
        display: flex;
        align-items: center;
        gap: var(--dwc-space-2);
        font-size: var(--dwc-text-base);
        font-weight: var(--dwc-weight-semibold);
        color: var(--dwc-text);
        margin-right: auto;
      }
      .brand-mark {
        display: grid;
        place-items: center;
        width: 1.875rem;
        height: 1.875rem;
        border-radius: var(--dwc-radius);
        background: color-mix(in oklab, var(--dwc-brand) 14%, var(--dwc-surface-raised));
        border: 1px solid var(--dwc-brand-border);
        color: var(--dwc-brand);
        --dwc-icon-size: 1.125rem;
        --dwc-icon-back: var(--dwc-brand);
        --dwc-icon-back-opacity: 0.3;
      }

      .menu-button {
        display: grid;
        place-items: center;
        width: var(--dwc-tap-target);
        height: var(--dwc-tap-target);
        border: 1px solid var(--dwc-border);
        border-radius: var(--dwc-radius);
        background: var(--dwc-surface-raised);
        color: var(--dwc-text-muted);
        cursor: pointer;
      }

      .body {
        display: grid;
        grid-template-columns: 1fr;
        min-height: 0;
      }

      /*
       * Skip link. global.css has styled one since the first commit and nothing
       * ever used the class — the shell lives in a shadow root, so a rule in the
       * document sheet could never have reached it.
       *
       * It earns its place here: the sidebar precedes main in the DOM, so with a
       * handful of saved sites a keyboard user tabs through every site and every
       * site action before reaching the address field. Hidden until focused.
       */
      .skip-link {
        position: absolute;
        top: 0;
        left: 0;
        padding: var(--dwc-space-2) var(--dwc-space-4);
        border: none;
        border-radius: 0 0 var(--dwc-radius) 0;
        background: var(--dwc-brand);
        color: var(--dwc-text-inverse);
        font: inherit;
        font-size: var(--dwc-text-sm);
        cursor: pointer;
        transform: translateY(-110%);
        transition: transform var(--dwc-duration-fast) var(--dwc-ease);
        z-index: var(--dwc-z-skip);
      }
      .skip-link:focus {
        transform: translateY(0);
      }

      aside {
        position: fixed;
        inset: 0 auto 0 0;
        z-index: var(--dwc-z-drawer);
        width: min(var(--dwc-sidebar-width), 85vw);
        display: flex;
        flex-direction: column;
        gap: var(--dwc-space-2);
        padding: var(--dwc-space-3);
        border-right: 1px solid var(--dwc-border);
        background: var(--dwc-surface-raised);
        overflow-y: auto;
        transform: translateX(-100%);
        transition: transform var(--dwc-duration) var(--dwc-ease);
      }
      aside[data-open='true'] {
        transform: translateX(0);
        box-shadow: var(--dwc-shadow-lg);
      }

      .scrim {
        position: fixed;
        inset: 0;
        z-index: var(--dwc-z-scrim);
        background: oklch(0% 0 0 / 0.45);
        backdrop-filter: blur(2px);
        border: none;
      }

      main {
        min-width: 0;
        padding: var(--dwc-space-4);
      }

      .content {
        max-width: var(--dwc-content-max);
        margin: 0 auto;
        display: grid;
        gap: var(--dwc-space-6);
      }

      /*
       * The collapse control only means anything beside a persistent sidebar. On
       * a phone the drawer is already all-or-nothing, and a second way to hide it
       * would just be a control that appears to do nothing.
       */
      .collapse-button {
        display: none;
      }

      @media (min-width: 60rem) {
        .body {
          grid-template-columns: var(--dwc-sidebar-width) 1fr;
          transition: grid-template-columns var(--dwc-duration) var(--dwc-ease-out);
        }
        .body:has(aside[data-collapsed='true']) {
          grid-template-columns: var(--dwc-sidebar-rail) 1fr;
        }

        .collapse-button {
          display: grid;
          place-items: center;
          min-width: var(--dwc-space-8);
          min-height: var(--dwc-space-8);
          border: none;
          border-radius: var(--dwc-radius);
          background: transparent;
          color: var(--dwc-text-muted);
          cursor: pointer;
        }
        .collapse-button:hover {
          background: var(--dwc-surface-sunken);
          color: var(--dwc-text);
        }

        aside[data-collapsed='true'] {
          width: var(--dwc-sidebar-rail);
          padding-inline: var(--dwc-space-1);
          overflow-x: hidden;
        }
        aside[data-collapsed='true'] .sidebar-head,
        aside[data-collapsed='true'] .sidebar-foot {
          justify-content: center;
        }

        aside {
          width: auto;
          /*
           * Two things were stopping this from sticking.
           *
           * 1. "inset: auto" was declared *after* "top". It is the shorthand for
           *    all four offsets, so it reset top back to auto — and a sticky
           *    element with top:auto has no offset to stick at. It has to come
           *    first, to clear the fixed insets the mobile drawer rule sets.
           *
           * 2. As a grid item it stretched to the full row height by default, so
           *    it was always exactly as tall as its container and had no room to
           *    move within it. "align-self: start" is what gives sticky something
           *    to do.
           */
          inset: auto;
          position: sticky;
          align-self: start;
          top: var(--dwc-header-height);
          height: calc(100dvh - var(--dwc-header-height));
          transform: none;
          box-shadow: none;
        }
        .menu-button,
        .scrim {
          display: none;
        }
        main {
          padding: var(--dwc-space-8);
        }
      }

      .sidebar-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--dwc-space-2);
        padding: var(--dwc-space-1) var(--dwc-space-2);
      }
      .sidebar-title {
        font-size: var(--dwc-text-xs);
        font-weight: var(--dwc-weight-semibold);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--dwc-text-subtle);
      }

      .sidebar-foot {
        margin-top: auto;
        padding-top: var(--dwc-space-3);
        border-top: 1px solid var(--dwc-border);
        display: flex;
        align-items: center;
        gap: var(--dwc-space-2);
      }
      /* The archived toggle takes the room; the theme control sits beside it. */
      .sidebar-foot dwc-button {
        flex: 1;
        min-width: 0;
      }

      .hero {
        display: grid;
        gap: var(--dwc-space-4);
        text-align: center;
        padding: var(--dwc-space-8) 0 var(--dwc-space-4);
      }
      h1 {
        margin: 0;
        font-family: var(--dwc-font-display);
        font-size: var(--dwc-text-4xl);
        font-weight: var(--dwc-weight-bold);
        line-height: var(--dwc-leading-tight);
        letter-spacing: var(--dwc-tracking-tight);
        color: var(--dwc-text);
        text-wrap: balance;
      }
      .lede {
        margin: 0 auto;
        max-width: 52ch;
        font-size: var(--dwc-text-lg);
        line-height: var(--dwc-leading-relaxed);
        color: var(--dwc-text-muted);
        text-wrap: pretty;
      }

      /* Example domains, so the empty state is one click from a real result
         instead of a blank field the reader has to think of input for. */
      .examples {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        align-items: center;
        gap: var(--dwc-space-2);
        font-size: var(--dwc-text-sm);
        color: var(--dwc-text-subtle);
      }
      .example {
        min-height: 2rem;
        padding: var(--dwc-space-1) var(--dwc-space-3);
        border: 1px solid var(--dwc-border);
        border-radius: var(--dwc-radius-full);
        background: var(--dwc-surface-raised);
        color: var(--dwc-text-muted);
        font-family: var(--dwc-font-mono);
        font-size: var(--dwc-text-xs);
        cursor: pointer;
      }
      .example:hover {
        border-color: var(--dwc-brand-border);
        background: var(--dwc-brand-subtle);
        color: var(--dwc-brand-text);
      }

      .input-wrap {
        container-type: inline-size;
        max-width: 40rem;
        margin: 0 auto;
        width: 100%;
      }

      .consent {
        display: flex;
        align-items: flex-start;
        gap: var(--dwc-space-2);
        justify-content: center;
        font-size: var(--dwc-text-sm);
        color: var(--dwc-text-muted);
      }
      .consent input {
        width: 1.1rem;
        height: 1.1rem;
        margin-top: 0.15rem;
        accent-color: var(--dwc-brand);
      }

      .panel {
        padding: var(--dwc-space-5);
        border: 1px solid var(--dwc-border);
        border-radius: var(--dwc-radius-lg);
        background: var(--dwc-surface-raised);
        box-shadow:
          inset 0 1px 0 var(--dwc-highlight),
          var(--dwc-shadow-sm);
      }

      /*
       * The password gate. Deliberately the whole viewport: with no session
       * there is no sidebar, no history and nothing to run, so framing it as a
       * dialog over the app would imply there is something behind it.
       */
      .gate {
        min-height: 100dvh;
        display: grid;
        place-items: center;
        padding: var(--dwc-space-4);
      }

      .gate-card {
        width: min(24rem, 100%);
        display: grid;
        gap: var(--dwc-space-3);
        padding: var(--dwc-space-6);
        border: 1px solid var(--dwc-border);
        border-radius: var(--dwc-radius-lg);
        background: var(--dwc-surface-raised);
      }

      .gate-card h1 {
        margin: 0;
        font-size: var(--dwc-text-xl);
        font-weight: var(--dwc-weight-semibold);
      }

      .gate-lede {
        margin: 0;
        color: var(--dwc-text-muted);
        font-size: var(--dwc-text-sm);
      }

      .gate-label {
        font-size: var(--dwc-text-sm);
        font-weight: var(--dwc-weight-medium);
      }

      .gate-card input {
        min-height: var(--dwc-tap-target);
        padding: 0 var(--dwc-space-3);
        border: 1px solid var(--dwc-border-strong);
        border-radius: var(--dwc-radius);
        background: var(--dwc-surface);
        color: var(--dwc-text);
        font: inherit;
      }

      .gate-card input:focus-visible {
        outline: 2px solid var(--dwc-brand);
        outline-offset: 2px;
      }

      .gate-error {
        margin: 0;
        color: var(--dwc-danger-text, var(--dwc-text));
        font-size: var(--dwc-text-sm);
      }

      .error {
        display: flex;
        align-items: center;
        gap: var(--dwc-space-2);
        padding: var(--dwc-space-4);
        border: 1px solid var(--dwc-bad-border);
        border-radius: var(--dwc-radius);
        background: var(--dwc-bad-subtle);
        color: var(--dwc-bad-text);
        font-size: var(--dwc-text-sm);
      }

      .error-dismiss {
        margin-left: auto;
        display: grid;
        place-items: center;
        min-width: var(--dwc-space-6);
        min-height: var(--dwc-space-6);
        border: none;
        border-radius: var(--dwc-radius-sm);
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      .error-dismiss:hover {
        background: var(--dwc-bad-border);
      }

      .report-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--dwc-space-2);
        justify-content: space-between;
      }
      .report-title {
        font-size: var(--dwc-text-xl);
        font-weight: var(--dwc-weight-semibold);
        color: var(--dwc-text);
        margin: 0;
      }
      .report-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--dwc-space-2);
      }

      @media print {
        :host::before {
          display: none;
        }
        header,
        aside,
        .report-actions,
        .hero,
        .scrim {
          display: none !important;
        }
        main {
          padding: 0;
        }
      }
    `,
  ];

  // --- state ---------------------------------------------------------------

  /**
   * Reactive state, declared via Lit's static `properties` API.
   *
   * Decorators would read better, but Vite 8's Oxc transform cannot lower them,
   * so they would reach the browser as invalid syntax. This API is fully
   * supported Lit and works regardless of bundler. See tsconfig.json for the
   * accompanying useDefineForClassFields note.
   */
  static override properties = {
    theme: { state: true },
    sidebarOpen: { state: true },
    sites: { state: true },
    reportsBySite: { state: true },
    selectedSiteId: { state: true },
    report: { state: true },
    liveVerdict: { state: true },
    running: { state: true },
    steps: { state: true },
    error: { state: true },
    throughputConsent: { state: true },
    showArchived: { state: true },
    pendingDelete: { state: true },
    sidebarCollapsed: { state: true },
    isDesktop: { state: true },
    controlUrl: { state: true },
    needsPassword: { state: true },
    password: { state: true },
    signingIn: { state: true },
    signInError: { state: true },
  };

  private theme: ThemeChoice = 'system';
  private sidebarOpen = false;
  private sites: SiteWithSummary[] = [];
  private reportsBySite: Record<string, ReportSummary[]> = {};
  private selectedSiteId: string | null = null;
  private report: Report | null = null;
  private liveVerdict: Verdict | null = null;
  private running = false;
  private steps: ProgressStep[] = [];
  private error: string | null = null;
  private throughputConsent = false;
  private showArchived = false;
  private pendingDelete: {
    kind: 'site' | 'report';
    id: string;
    label: string;
    /** Set for reports, so the history list can be reloaded after the delete. */
    siteId?: string;
  } | null = null;
  private sidebarCollapsed = false;
  private isDesktop = false;
  /** Where the browser measures its baseline. Null means same-origin. */
  private controlUrl: string | null = null;

  /** Public endpoints to time alongside the target. Empty unless configured. */
  private referenceUrls: readonly string[] = [];

  /**
   * Whether the rail is actually collapsed, as opposed to remembered as such.
   *
   * `sidebarCollapsed` is persisted and survives a resize; the control that
   * unsets it only exists above 60rem. Reading the two together in one place is
   * what stops the drawer and the nav tree disagreeing — they did, and the drawer
   * opened as a rail of unlabelled icons with no way back.
   */
  private get railCollapsed(): boolean {
    return this.isDesktop && this.sidebarCollapsed;
  }

  /** True once the server has refused for want of a session. */
  private needsPassword = false;
  private password = '';
  private signingIn = false;
  private signInError: string | null = null;

  /**
   * Drives which side of the 60rem breakpoint we are on.
   *
   * A media query alone could hide and show two copies of the theme toggle, but
   * two copies means two tab stops and two controls for a screen reader to
   * announce for one setting. Rendering one instance in the place that suits the
   * viewport is the honest version.
   */
  private readonly desktopQuery = window.matchMedia('(min-width: 60rem)');

  private readonly onBreakpoint = (event: MediaQueryListEvent): void => {
    this.isDesktop = event.matches;
  };

  private readonly onPopState = (): void => {
    void this.routeTo(window.location.pathname, { push: false });
  };

  /**
   * Stops a reload or a closed tab silently discarding a running diagnostic.
   *
   * Registered only while `running` is true — a permanently attached handler
   * would prompt on every navigation, which trains people to dismiss it.
   */
  private readonly onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.running) return;
    event.preventDefault();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.theme = readStoredTheme(localStorage);
    applyTheme(this.theme, document.documentElement);
    this.sidebarCollapsed = localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';

    this.isDesktop = this.desktopQuery.matches;
    this.desktopQuery.addEventListener('change', this.onBreakpoint);
    window.addEventListener('popstate', this.onPopState);
    window.addEventListener('beforeunload', this.onBeforeUnload);

    void this.start();
  }

  override disconnectedCallback(): void {
    this.desktopQuery.removeEventListener('change', this.onBreakpoint);
    window.removeEventListener('popstate', this.onPopState);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    super.disconnectedCallback();
  }

  /**
   * First load: the sites list, the deployment's control endpoint, and whatever
   * the URL says we should be looking at.
   *
   * The health call is what tells the browser where to measure its latency
   * baseline. It fails soft — a missing answer just means same-origin, which is
   * the behaviour this had before the setting existed.
   */
  private async start(): Promise<void> {
    void api
      .health()
      .then((health) => {
        this.controlUrl = health.controlUrl;
        this.referenceUrls = health.referenceUrls;
      })
      .catch(() => {
        // Health is unauthenticated, so a failure here is a real outage rather
        // than a missing session. Same-origin is the honest fallback.
        this.controlUrl = null;
        this.referenceUrls = [];
      });

    await this.refreshSites();
    await this.routeTo(window.location.pathname, { push: false });
  }

  // --- routing -------------------------------------------------------------

  /**
   * Reports have real URLs, so a refresh lands where you were.
   *
   * Previously every reload cold-started to the hero and threw away what you were
   * reading. The API already serves index.html for any non-/api path, so this
   * needed nothing server-side — and it makes a report shareable as a side
   * effect, which is the whole point of keeping history.
   */
  private async routeTo(path: string, options: { push: boolean }): Promise<void> {
    const match = /^\/report\/([\w-]+)\/?$/.exec(path);

    if (match === null) {
      this.report = null;
      this.liveVerdict = null;
      if (options.push) history.pushState(null, '', '/');
      return;
    }

    await this.openReport(match[1]!, { push: options.push });
  }

  /** Records the current report in the address bar without reloading anything. */
  private pushReportUrl(reportId: string): void {
    const url = `/report/${reportId}`;
    if (window.location.pathname !== url) history.pushState(null, '', url);
  }

  // --- data ----------------------------------------------------------------

  private async refreshSites(): Promise<void> {
    try {
      /*
       * The archived view lists every site, not only archived ones.
       *
       * A report can be archived on its own while its site stays active. Listing
       * only archived sites made those reports unreachable: the only view that
       * shows them had nothing in it to expand. Showing every site here is what
       * makes "archived" mean archived *things* rather than archived sites.
       */
      this.sites = await api.listSites(this.showArchived ? 'all' : 'active');
    } catch (error) {
      /*
       * A 401 here is not an error to show in a banner — it is the instance
       * asking who you are. This is the first authenticated call the app makes,
       * so it is where the gate goes up.
       */
      if (error instanceof ApiError && error.needsPassword) {
        this.needsPassword = true;
        return;
      }
      this.error = error instanceof ApiError ? error.message : 'Could not load your saved sites.';
    }
  }

  private async loadReports(siteId: string): Promise<void> {
    try {
      this.reportsBySite = {
        ...this.reportsBySite,
        [siteId]: await api.listReports(siteId, this.showArchived ? 'archived' : 'active'),
      };
    } catch {
      // A failed history fetch should not blank the report already on screen.
    }
  }

  private async openReport(reportId: string, options = { push: true }): Promise<void> {
    try {
      this.liveVerdict = null;
      this.report = await api.getReport(reportId);
      this.sidebarOpen = false;
      if (options.push) this.pushReportUrl(reportId);
    } catch (error) {
      /*
       * A URL can outlive the report it names — deleted, or from someone else's
       * instance. Falling back to the hero with an explanation beats leaving a
       * blank page under a URL that will never work again.
       */
      if (error instanceof ApiError && error.status === 404) {
        this.report = null;
        this.error = 'That report no longer exists.';
        history.replaceState(null, '', '/');
        return;
      }
      this.error = error instanceof ApiError ? error.message : 'Could not open that report.';
    }
  }

  // --- running a diagnostic -------------------------------------------------

  private resetSteps(): void {
    this.steps = PHASES.map((phase) => ({
      key: phase.key,
      label: phase.label,
      status: 'pending',
      message: phase.label,
    }));
  }

  private setStep(key: string, status: ProgressStep['status'], message: string): void {
    this.steps = this.steps.map((step) => (step.key === key ? { ...step, status, message } : step));
  }

  private async diagnose(url: string, siteId?: string): Promise<void> {
    this.running = true;
    this.error = null;
    this.report = null;
    this.liveVerdict = null;
    this.resetSteps();
    this.sidebarOpen = false;

    try {
      for await (const event of streamDiagnostic(url, siteId === undefined ? {} : { siteId })) {
        if (event.type === 'phase') {
          this.setStep(event.phase, event.status, event.message);
        } else if (event.type === 'complete') {
          this.report = event.report;
          this.pushReportUrl(event.report.id);
        } else if (event.type === 'failed') {
          this.error = event.error;
        }
      }

      await this.refreshSites();
      if (this.report !== null) await this.loadReports(this.report.siteId);

      // Only now can the browser half run — and only with it can the engine
      // distinguish a slow site from a slow connection.
      if (this.report?.evidence != null) {
        await this.measureClient(this.report);
      }
    } catch (error) {
      this.error = error instanceof ApiError ? error.message : 'The check could not be completed.';
    } finally {
      this.running = false;
    }
  }

  private async measureClient(report: Report): Promise<void> {
    const target = report.evidence?.server.target.normalizedUrl;
    if (target === undefined) return;

    this.setStep('client', 'started', 'Measuring your connection…');
    try {
      const client = await runClientProbe({
        targetUrl: target,
        controlUrl: this.controlUrl,
        referenceUrls: this.referenceUrls,
        throughputConsent: this.throughputConsent,
        onProgress: (message) => this.setStep('client', 'started', message),
      });

      this.liveVerdict = await api.submitClientEvidence(report.id, client);
      this.setStep('client', 'complete', 'Your connection measured');
    } catch {
      // The server-side verdict still stands and already says the user's
      // connection was not measured — no silent guessing.
      this.setStep('client', 'failed', 'Could not measure your connection');
    }
  }

  // --- actions -------------------------------------------------------------

  private onTheme(event: CustomEvent<{ choice: ThemeChoice }>): void {
    this.theme = event.detail.choice;
    applyTheme(this.theme, document.documentElement);
    localStorage.setItem(THEME_STORAGE_KEY, this.theme);
  }

  private async renameSite(siteId: string, current: string): Promise<void> {
    const next = prompt('Rename this site', current);
    if (next === null || next.trim() === '' || next === current) return;
    await api.updateSite(siteId, { label: next.trim() });
    await this.refreshSites();
  }

  private async confirmDelete(): Promise<void> {
    const pending = this.pendingDelete;
    if (pending === null) return;

    const siteId = pending.kind === 'site' ? pending.id : (pending.siteId ?? null);

    if (pending.kind === 'site') {
      await api.deleteSite(pending.id);
      if (this.report?.siteId === pending.id) this.clearOpenReport();
    } else {
      await api.deleteReport(pending.id);
      if (this.report?.id === pending.id) this.clearOpenReport();
    }

    this.pendingDelete = null;
    await this.refreshSites();

    // refreshSites only reloads the site list. Without this the expanded history
    // keeps showing the run that was just deleted until the user collapses it.
    if (pending.kind === 'report' && siteId !== null) await this.loadReports(siteId);
  }

  /** Closes whatever is open and takes the report id out of the address bar. */
  private clearOpenReport(): void {
    this.report = null;
    this.liveVerdict = null;
    if (window.location.pathname !== '/') history.replaceState(null, '', '/');
  }

  private async archiveReport(reportId: string, siteId: string): Promise<void> {
    await api.archiveReport(reportId);
    if (this.report?.id === reportId) this.clearOpenReport();
    await this.loadReports(siteId);
    await this.refreshSites();
  }

  private async restoreReport(reportId: string, siteId: string): Promise<void> {
    await api.restoreReport(reportId);
    await this.loadReports(siteId);
    await this.refreshSites();
  }

  private toggleSidebarCollapsed(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(this.sidebarCollapsed));
  }

  // --- render --------------------------------------------------------------

  override render(): TemplateResult {
    if (this.needsPassword) return this.renderLogin();

    return html`
      <div class="shell">
        <button
          class="skip-link"
          type="button"
          @click=${() => {
            // A button rather than an <a href="#main">: fragment navigation cannot
            // address an id inside a shadow root, so the anchor would do nothing.
            this.renderRoot.querySelector('main')?.focus();
          }}
        >
          Skip to the main content
        </button>

        <header>
          <button
            class="menu-button"
            type="button"
            aria-label=${this.sidebarOpen ? 'Close menu' : 'Open menu'}
            aria-expanded=${this.sidebarOpen ? 'true' : 'false'}
            @click=${() => {
              this.sidebarOpen = !this.sidebarOpen;
            }}
          >
            <dwc-icon name=${this.sidebarOpen ? 'close' : 'menu'}></dwc-icon>
          </button>

          <span class="brand">
            <span class="brand-mark">
              <dwc-icon name="route" weight="duotone"></dwc-icon>
            </span>
            Connection Diagnostics
          </span>

          ${
            this.isDesktop
              ? html`<dwc-theme-toggle
                  .choice=${this.theme}
                  @theme-change=${this.onTheme}
                ></dwc-theme-toggle>`
              : nothing
          }
        </header>

        <div class="body">
          ${this.renderSidebar()}
          <main tabindex="-1">
            <div class="content">${this.renderError()}${this.renderMain()}</div>
          </main>
        </div>
      </div>

      <dwc-dialog
        .open=${this.pendingDelete !== null}
        heading="Delete permanently?"
        message=${
          this.pendingDelete === null
            ? ''
            : `"${this.pendingDelete.label}" will be deleted for good. Archiving keeps it out of the way but recoverable — deleting cannot be undone.`
        }
        confirm-label="Delete permanently"
        danger
        @confirm=${() => void this.confirmDelete()}
        @cancel=${() => {
          this.pendingDelete = null;
        }}
      ></dwc-dialog>
    `;
  }

  /**
   * The error banner, in every state rather than only on the hero.
   *
   * It used to live inside the hero branch of renderMain, which returns early
   * whenever a report is on screen — so a failed re-run, a rate limit or a lost
   * connection produced nothing at all for the reader to see.
   */
  /**
   * The password gate for a shared instance.
   *
   * Rendered instead of the whole shell rather than over it: with no session
   * there is no site list, no history and nothing to run, so a dialog floating
   * above an empty app would only imply otherwise. `AUTH_MODE=none` — the
   * default, and every local install — never reaches this.
   */
  private renderLogin(): TemplateResult {
    return html`
      <div class="gate">
        <form
          class="gate-card"
          @submit=${(event: Event) => {
            event.preventDefault();
            void this.signIn();
          }}
        >
          <h1>Connection Diagnostics</h1>
          <p class="gate-lede">This instance is password protected.</p>

          <label class="gate-label" for="password">Password</label>
          <input
            id="password"
            type="password"
            name="password"
            autocomplete="current-password"
            .value=${this.password}
            ?disabled=${this.signingIn}
            @input=${(event: Event) => {
              this.password = (event.target as HTMLInputElement).value;
              this.signInError = null;
            }}
          />

          ${
            this.signInError === null
              ? nothing
              : html`<p class="gate-error" role="alert">${this.signInError}</p>`
          }

          <dwc-button type="submit" ?loading=${this.signingIn} ?disabled=${this.password === ''}>
            Sign in
          </dwc-button>
        </form>
      </div>
    `;
  }

  private async signIn(): Promise<void> {
    if (this.password === '') return;
    this.signingIn = true;
    this.signInError = null;
    try {
      await api.signIn(this.password);
      this.needsPassword = false;
      this.password = '';
      // The session cookie now exists, so the load that failed can be retried.
      await this.start();
    } catch (error) {
      this.signInError =
        error instanceof ApiError && error.needsPassword
          ? 'That password is not correct.'
          : error instanceof Error
            ? error.message
            : 'Could not sign in.';
    } finally {
      this.signingIn = false;
    }
  }

  private renderError(): TemplateResult | typeof nothing {
    if (this.error === null) return nothing;

    return html`
      <p class="error" role="alert">
        <dwc-icon name="warning"></dwc-icon>${this.error}
        <button
          class="error-dismiss"
          type="button"
          aria-label="Dismiss this message"
          @click=${() => {
            this.error = null;
          }}
        >
          <dwc-icon name="close"></dwc-icon>
        </button>
      </p>
    `;
  }

  private renderSidebar(): TemplateResult {
    return html`
      ${
        this.sidebarOpen
          ? html`<button
              class="scrim"
              aria-label="Close menu"
              @click=${() => {
                this.sidebarOpen = false;
              }}
            ></button>`
          : nothing
      }

      <!--
        The closed drawer is inert, not merely off-screen.

        It stays mounted so it can animate, and 'transform' hides nothing from the
        keyboard: every control inside it remained a tab stop, so tabbing from the
        address field walked invisibly through the whole sidebar before reaching
        anything on the page. Inert removes it from the tab order and the
        accessibility tree together, which is what "hidden" is supposed to mean.
      -->
      <aside
        data-open=${this.sidebarOpen ? 'true' : 'false'}
        ${
          /*
           * The rail is a desktop idea, and the flag outlives the viewport.
           *
           * `sidebarCollapsed` is remembered in localStorage and the control that
           * unsets it is display:none below 60rem — so collapsing on a desktop and
           * then loading on a phone opened the drawer as a label-less rail with no
           * way back out of it. The state is kept, because widening the window
           * should restore what you chose; it is simply not applied down here.
           */ ''
        }
        data-collapsed=${this.railCollapsed ? 'true' : 'false'}
        ?inert=${!this.isDesktop && !this.sidebarOpen}
        aria-label="Saved sites"
      >
        <div class="sidebar-head">
          ${
            this.sidebarCollapsed
              ? nothing
              : html`<span class="sidebar-title">
                  ${this.showArchived ? 'Archived' : 'Your sites'}
                </span>`
          }
          ${
            this.sidebarCollapsed
              ? nothing
              : html`<dwc-button
                  size="sm"
                  variant="ghost"
                  @click=${() => {
                    this.clearOpenReport();
                    this.sidebarOpen = false;
                  }}
                >
                  <dwc-icon name="plus"></dwc-icon>
                  New
                </dwc-button>`
          }

          <button
            class="collapse-button"
            type="button"
            aria-label=${this.sidebarCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            aria-expanded=${this.sidebarCollapsed ? 'false' : 'true'}
            @click=${() => this.toggleSidebarCollapsed()}
          >
            <dwc-icon name=${this.sidebarCollapsed ? 'chevron' : 'chevron-left'}></dwc-icon>
          </button>
        </div>

        <dwc-nav-tree
          .sites=${this.sites}
          .reportsBySite=${this.reportsBySite}
          ?collapsed=${this.railCollapsed}
          view=${this.showArchived ? 'archived' : 'active'}
          selected-site=${this.selectedSiteId ?? ''}
          selected-report=${this.report?.id ?? ''}
          @site-expand=${(e: CustomEvent<{ siteId: string }>) => void this.loadReports(e.detail.siteId)}
          @site-select=${(e: CustomEvent<{ siteId: string }>) => {
            this.selectedSiteId = e.detail.siteId;
            void this.loadReports(e.detail.siteId);
          }}
          @site-rerun=${(e: CustomEvent<{ siteId: string; url: string }>) =>
            void this.diagnose(e.detail.url, e.detail.siteId)}
          @site-rename=${(e: CustomEvent<{ siteId: string; label: string }>) =>
            void this.renameSite(e.detail.siteId, e.detail.label)}
          @site-archive=${async (e: CustomEvent<{ siteId: string }>) => {
            await api.archiveSite(e.detail.siteId);
            await this.refreshSites();
          }}
          @site-restore=${async (e: CustomEvent<{ siteId: string }>) => {
            await api.restoreSite(e.detail.siteId);
            await this.refreshSites();
          }}
          @site-delete=${(e: CustomEvent<{ siteId: string; label: string }>) => {
            this.pendingDelete = { kind: 'site', id: e.detail.siteId, label: e.detail.label };
          }}
          @report-select=${(e: CustomEvent<{ reportId: string }>) =>
            void this.openReport(e.detail.reportId)}
          @report-archive=${(e: CustomEvent<{ reportId: string; siteId: string }>) =>
            void this.archiveReport(e.detail.reportId, e.detail.siteId)}
          @report-restore=${(e: CustomEvent<{ reportId: string; siteId: string }>) =>
            void this.restoreReport(e.detail.reportId, e.detail.siteId)}
          @report-delete=${(
            e: CustomEvent<{ reportId: string; siteId: string; label: string }>,
          ) => {
            this.pendingDelete = {
              kind: 'report',
              id: e.detail.reportId,
              label: e.detail.label,
              siteId: e.detail.siteId,
            };
          }}
        ></dwc-nav-tree>

        <div class="sidebar-foot">
          ${
            this.sidebarCollapsed
              ? nothing
              : html`<dwc-button
                  size="sm"
                  variant="ghost"
                  full
                  @click=${async () => {
                    this.showArchived = !this.showArchived;
                    this.reportsBySite = {};
                    await this.refreshSites();
                  }}
                >
                  <dwc-icon name=${this.showArchived ? 'restore' : 'archive'}></dwc-icon>
                  ${this.showArchived ? 'Back to your sites' : 'View archived'}
                </dwc-button>`
          }

          <!--
            One theme control, placed where the viewport can reach it. On a phone
            the header has no room for it and the drawer is the only surface the
            user can open, so it lives here instead of being duplicated.
          -->
          ${
            this.isDesktop
              ? nothing
              : html`<dwc-theme-toggle
                  .choice=${this.theme}
                  @theme-change=${this.onTheme}
                ></dwc-theme-toggle>`
          }
        </div>
      </aside>
    `;
  }

  private renderMain(): TemplateResult {
    if (this.report !== null && !this.running) {
      return html`
        <div class="report-head no-print">
          <h2 class="report-title">${this.report.evidence?.server.target.host ?? 'Report'}</h2>
          <div class="report-actions">
            <dwc-button
              size="sm"
              @click=${() =>
                void this.diagnose(
                  this.report?.evidence?.server.target.normalizedUrl ?? '',
                  this.report?.siteId,
                )}
            >
              <dwc-icon name="refresh"></dwc-icon>
              Run again
            </dwc-button>
            <dwc-button size="sm" @click=${() => this.exportJson()}>
              <dwc-icon name="download"></dwc-icon>
              Export JSON
            </dwc-button>
            <dwc-button size="sm" @click=${() => window.print()}>
              <dwc-icon name="print"></dwc-icon>
              Print / PDF
            </dwc-button>
          </div>
        </div>

        <dwc-report-view .report=${this.report} .liveVerdict=${this.liveVerdict}></dwc-report-view>
      `;
    }

    return html`
      <div class="hero">
        <h1>Is it the website, or is it you?</h1>
        <p class="lede">
          Enter any website address. We check it from our own server, measure your connection
          separately, and tell you plainly which one is the problem.
        </p>
      </div>

      <div class="input-wrap">
        <dwc-url-input
          ?busy=${this.running}
          @diagnose=${(e: CustomEvent<{ url: string }>) => void this.diagnose(e.detail.url)}
        ></dwc-url-input>
      </div>

      <!-- One click to a real result. An empty field with no suggestion makes the
           reader supply both the intent and the example. -->
      <div class="examples">
        <span>Try</span>
        ${['example.com', 'wikipedia.org', 'info.cern.ch'].map(
          (host) => html`
            <button
              class="example"
              type="button"
              ?disabled=${this.running}
              @click=${() => void this.diagnose(host)}
            >
              ${host}
            </button>
          `,
        )}
      </div>

      <label class="consent">
        <input
          type="checkbox"
          .checked=${this.throughputConsent}
          @change=${(e: Event) => {
            this.throughputConsent = (e.target as HTMLInputElement).checked;
          }}
        />
        <span>
          Also measure my connection speed. This downloads about 4&nbsp;MB and uploads 1&nbsp;MB, so
          skip it on a metered connection.
        </span>
      </label>

      ${
        this.running
          ? html`
              <div class="panel">
                <dwc-progress-steps .steps=${this.steps}></dwc-progress-steps>
              </div>
            `
          : nothing
      }
    `;
  }

  /**
   * Export the full report as JSON.
   *
   * Uses a blob URL and a synthetic click — no server round trip, and the user
   * ends up owning the file rather than us hosting it anywhere.
   */
  private exportJson(): void {
    if (this.report === null) return;

    const payload = {
      ...this.report,
      verdict: this.liveVerdict ?? this.report.verdict,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const host = this.report.evidence?.server.target.host ?? 'report';

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${host}-${this.report.createdAt.slice(0, 10)}.json`;
    anchor.click();

    URL.revokeObjectURL(url);
  }
}

customElements.define('dwc-app', DwcApp);

declare global {
  interface HTMLElementTagNameMap {
    'dwc-app': DwcApp;
  }
}
