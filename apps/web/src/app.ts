import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import type { ProbePhase, Report, ReportSummary, SiteWithSummary, Verdict } from '@dwc/contracts';
import { applyTheme, readStoredTheme, THEME_STORAGE_KEY, type ThemeChoice } from '@dwc/tokens';
import { sharedStyles, type ProgressStep } from '@dwc/ui';
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

export class DwcApp extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: block;
        min-height: 100vh;
        min-height: 100dvh;
        background: var(--dwc-surface);
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
        z-index: 20;
        display: flex;
        align-items: center;
        gap: var(--dwc-space-3);
        padding: var(--dwc-space-3) var(--dwc-space-4);
        border-bottom: 1px solid var(--dwc-border);
        background: color-mix(in oklab, var(--dwc-surface) 88%, transparent);
        backdrop-filter: blur(8px);
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
      .brand dwc-icon {
        color: var(--dwc-brand);
        --dwc-icon-size: 1.375rem;
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

      aside {
        position: fixed;
        inset: 0 auto 0 0;
        z-index: 30;
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
        z-index: 25;
        background: oklch(0% 0 0 / 0.4);
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

      @media (min-width: 60rem) {
        .body {
          grid-template-columns: var(--dwc-sidebar-width) 1fr;
        }
        aside {
          position: sticky;
          top: 3.5rem;
          height: calc(100dvh - 3.5rem);
          transform: none;
          box-shadow: none;
          inset: auto;
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
      }

      .hero {
        display: grid;
        gap: var(--dwc-space-4);
        text-align: center;
        padding: var(--dwc-space-8) 0 var(--dwc-space-4);
      }
      h1 {
        margin: 0;
        font-size: var(--dwc-text-3xl);
        font-weight: var(--dwc-weight-bold);
        line-height: var(--dwc-leading-tight);
        color: var(--dwc-text);
        text-wrap: balance;
      }
      .lede {
        margin: 0 auto;
        max-width: 54ch;
        font-size: var(--dwc-text-lg);
        line-height: var(--dwc-leading-relaxed);
        color: var(--dwc-text-muted);
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
  private pendingDelete: { kind: 'site' | 'report'; id: string; label: string } | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.theme = readStoredTheme(localStorage);
    applyTheme(this.theme, document.documentElement);
    void this.refreshSites();
  }

  // --- data ----------------------------------------------------------------

  private async refreshSites(): Promise<void> {
    try {
      this.sites = await api.listSites(this.showArchived ? 'archived' : 'active');
    } catch (error) {
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

  private async openReport(reportId: string): Promise<void> {
    try {
      this.liveVerdict = null;
      this.report = await api.getReport(reportId);
      this.sidebarOpen = false;
    } catch (error) {
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
    this.steps = this.steps.map((step) =>
      step.key === key ? { ...step, status, message } : step,
    );
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

    if (pending.kind === 'site') {
      await api.deleteSite(pending.id);
      if (this.report?.siteId === pending.id) this.report = null;
    } else {
      await api.deleteReport(pending.id);
      if (this.report?.id === pending.id) this.report = null;
    }

    this.pendingDelete = null;
    await this.refreshSites();
  }

  // --- render --------------------------------------------------------------

  override render(): TemplateResult {
    return html`
      <div class="shell">
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
            <dwc-icon name="route"></dwc-icon>
            Connection Diagnostics
          </span>

          <dwc-theme-toggle .choice=${this.theme} @theme-change=${this.onTheme}></dwc-theme-toggle>
        </header>

        <div class="body">
          ${this.renderSidebar()}
          <main>
            <div class="content">${this.renderMain()}</div>
          </main>
        </div>
      </div>

      <dwc-dialog
        .open=${this.pendingDelete !== null}
        heading="Delete permanently?"
        message=${this.pendingDelete === null
          ? ''
          : `"${this.pendingDelete.label}" will be deleted for good. Archiving keeps it out of the way but recoverable — deleting cannot be undone.`}
        confirm-label="Delete permanently"
        danger
        @confirm=${() => void this.confirmDelete()}
        @cancel=${() => {
          this.pendingDelete = null;
        }}
      ></dwc-dialog>
    `;
  }

  private renderSidebar(): TemplateResult {
    return html`
      ${this.sidebarOpen
        ? html`<button
            class="scrim"
            aria-label="Close menu"
            @click=${() => {
              this.sidebarOpen = false;
            }}
          ></button>`
        : nothing}

      <aside data-open=${this.sidebarOpen ? 'true' : 'false'} aria-label="Saved sites">
        <div class="sidebar-head">
          <span class="sidebar-title">${this.showArchived ? 'Archived' : 'Your sites'}</span>
          <dwc-button
            size="sm"
            variant="ghost"
            @click=${() => {
              this.report = null;
              this.sidebarOpen = false;
            }}
          >
            <dwc-icon name="plus"></dwc-icon>
            New
          </dwc-button>
        </div>

        <dwc-nav-tree
          .sites=${this.sites}
          .reportsBySite=${this.reportsBySite}
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
        ></dwc-nav-tree>

        <div class="sidebar-foot">
          <dwc-button
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
          </dwc-button>
        </div>
      </aside>
    `;
  }

  private renderMain(): TemplateResult {
    if (this.report !== null && !this.running) {
      return html`
        <div class="report-head no-print">
          <h2 class="report-title">
            ${this.report.evidence?.server.target.host ?? 'Report'}
          </h2>
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

      ${this.error === null
        ? nothing
        : html`<p class="error" role="alert"><dwc-icon name="warning"></dwc-icon>${this.error}</p>`}

      ${this.running
        ? html`
            <div class="panel">
              <dwc-progress-steps .steps=${this.steps}></dwc-progress-steps>
            </div>
          `
        : nothing}
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
