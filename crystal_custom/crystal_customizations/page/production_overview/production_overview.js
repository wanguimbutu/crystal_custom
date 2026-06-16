frappe.pages['production-overview'].on_page_load = function (wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'Production Overview',
        single_column: true,
    });
    new ProductionOverview(page);
};

class ProductionOverview {
    constructor(page) {
        this.page = page;
        this.data  = { mrs: [], mr_items: [], work_orders: [], paint_orders: [] };
        this.active_tab = 'requests';
        this._produced = new Set(JSON.parse(localStorage.getItem('po_produced') || '[]'));
        this._setup_page();
        this.load();
    }

    _setup_page() {
        this.page.add_field({
            label: 'From Date', fieldtype: 'Date', fieldname: 'from_date',
            change: () => this.load(),
        });
        this.page.add_field({
            label: 'To Date', fieldtype: 'Date', fieldname: 'to_date',
            change: () => this.load(),
        });
        this.page.add_button(__('Refresh'), () => this.load(), 'octicon octicon-sync');
        this.container = $('<div class="po-container"></div>').appendTo(this.page.main);
    }

    // ── Data ─────────────────────────────────────────────────────────────────

    load() {
        this.container.html(this._loading_html());
        const from_date = this.page.fields_dict.from_date.get_value() || null;
        const to_date   = this.page.fields_dict.to_date.get_value()   || null;
        frappe.call({
            method: 'crystal_custom.crystal_customizations.page.production_overview.production_overview.get_production_data',
            args: { from_date, to_date },
            freeze: false,
            callback: (r) => {
                if (r.message) {
                    this.data = r.message;
                    this.render();
                }
            },
        });
    }

    _loading_html() {
        return `<div style="text-align:center;padding:60px;color:#6b7280;">
            <div class="spinner-border text-primary" role="status"></div>
            <p style="margin-top:16px;">Loading production data…</p>
        </div>`;
    }

    // ── Render ────────────────────────────────────────────────────────────────

    render() {
        const { mrs, mr_items, work_orders, paint_orders = [] } = this.data;

        const pending_mrs  = mrs.filter(m => m.status !== 'Stopped' && m.status !== 'Cancelled');
        const active_wos   = work_orders.filter(w => w.status !== 'Completed');
        const short_wos    = work_orders.filter(w => !w.can_start && w.status !== 'Completed');
        const agg_count    = this._aggregate_items().length;

        const kpi = this._kpi_row([
            { label: 'Pending Requests',   value: pending_mrs.length,  color: '#667eea, #764ba2' },
            { label: 'Active Work Orders', value: active_wos.length,   color: '#43e97b, #38f9d7' },
            { label: 'Items to Produce',   value: agg_count,           color: '#f093fb, #f5576c' },
            { label: 'Colour Specs',       value: paint_orders.length, color: '#f59e0b, #d97706' },
        ]);

        const tabs = `
            <div class="po-tabs">
                <button class="po-tab-btn ${this.active_tab === 'requests'   ? 'po-tab-active' : ''}" data-tab="requests">
                    &#128203; Production Requests
                    <span class="po-tab-badge">${pending_mrs.length}</span>
                </button>
                <button class="po-tab-btn ${this.active_tab === 'aggregate'  ? 'po-tab-active' : ''}" data-tab="aggregate">
                    &#128196; Aggregated Items
                    <span class="po-tab-badge">${agg_count}</span>
                </button>
                <button class="po-tab-btn ${this.active_tab === 'workorders' ? 'po-tab-active' : ''}" data-tab="workorders">
                    &#9881; Work Orders
                    <span class="po-tab-badge">${work_orders.length}</span>
                </button>
                <button class="po-tab-btn ${this.active_tab === 'materials'  ? 'po-tab-active' : ''}" data-tab="materials">
                    &#128230; Material Readiness
                    <span class="po-tab-badge ${short_wos.length ? 'po-tab-badge-warn' : ''}">${short_wos.length}</span>
                </button>
                <button class="po-tab-btn ${this.active_tab === 'colours'    ? 'po-tab-active' : ''}" data-tab="colours">
                    &#127758; Colour Specs
                    ${paint_orders.length ? `<span class="po-tab-badge po-tab-badge-warn">${paint_orders.length}</span>` : ''}
                </button>
            </div>
            <div class="po-tab-content" id="po-tab-content"></div>`;

        this.container.html(`${kpi}${tabs}${this._styles()}`);
        this._render_active_tab();
        this._attach_events();
    }

    _render_active_tab() {
        const $content = this.container.find('#po-tab-content');
        if (this.active_tab === 'requests')   $content.html(this._render_requests_tab());
        if (this.active_tab === 'aggregate')  $content.html(this._render_aggregate_tab());
        if (this.active_tab === 'workorders') $content.html(this._render_workorders_tab());
        if (this.active_tab === 'materials')  $content.html(this._render_materials_tab());
        if (this.active_tab === 'colours')    $content.html(this._render_colours_tab());
        this._attach_tab_events();
    }

    // ── Requests tab ─────────────────────────────────────────────────────────

    _render_requests_tab() {
        const { mrs, mr_items } = this.data;
        const items_by_mr = {};
        mr_items.forEach(i => {
            if (!items_by_mr[i.mr_name]) items_by_mr[i.mr_name] = [];
            items_by_mr[i.mr_name].push(i);
        });

        const wo_mr_set = new Set(this.data.work_orders.map(w => w.mr_name).filter(Boolean));

        if (!mrs.length) {
            return `<div class="po-empty">No production requests found.</div>`;
        }

        const cards = mrs.map(mr => {
            const items   = items_by_mr[mr.name] || [];
            const has_wos = wo_mr_set.has(mr.name);
            const status_color = {
                'Draft':             '#6b7280',
                'Submitted':         '#3b82f6',
                'Partially Ordered': '#f59e0b',
                'Ordered':           '#10b981',
                'Transferred':       '#10b981',
                'Issued':            '#10b981',
                'Received':          '#10b981',
            }[mr.status] || '#6b7280';

            const item_rows = items.map(i => {
                const wo_for_item = this.data.work_orders.find(w => w.mr_name === mr.name && w.production_item === i.item_code);
                const wo_badge = wo_for_item
                    ? `<span class="po-wo-badge" title="${wo_for_item.name}">${wo_for_item.status}</span>`
                    : `<button class="btn btn-xs btn-primary po-create-wo-btn"
                            data-mr="${frappe.utils.escape_html(mr.name)}"
                            data-item="${frappe.utils.escape_html(i.item_code)}"
                            data-qty="${i.qty}"
                            data-uom="${frappe.utils.escape_html(i.uom || '')}">
                            + Create WO
                       </button>`;
                const truck_cell = i.trucks
                    ? `<span class="po-truck-tag">&#128666; ${frappe.utils.escape_html(i.trucks)}</span>`
                    : `<span style="color:#9ca3af;font-size:11px;">—</span>`;
                return `<tr>
                    <td><strong>${frappe.utils.escape_html(i.item_code)}</strong></td>
                    <td>${frappe.utils.escape_html(i.item_name || '')}</td>
                    <td class="po-r">${flt(i.qty, 2)} ${frappe.utils.escape_html(i.uom || '')}</td>
                    <td>${truck_cell}</td>
                    <td>${wo_badge}</td>
                </tr>`;
            }).join('');

            return `<div class="po-mr-card">
                <div class="po-mr-head">
                    <span>
                        <a href="/app/material-request/${mr.name}" target="_blank" class="po-mr-link">
                            &#128203; ${frappe.utils.escape_html(mr.name)}
                        </a>
                    </span>
                    <span style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <span class="po-status-dot" style="background:${status_color};">${frappe.utils.escape_html(mr.status)}</span>
                        <span style="font-size:11px;color:#94a3b8;">${frappe.datetime.str_to_user(mr.transaction_date)}</span>
                        ${mr.schedule_date ? `<span style="font-size:11px;color:#f59e0b;">Due: ${frappe.datetime.str_to_user(mr.schedule_date)}</span>` : ''}
                        <button class="btn btn-xs btn-danger po-close-mr-btn"
                            data-mr="${frappe.utils.escape_html(mr.name)}"
                            title="Stop this request and remove from active list"
                            style="margin-left:4px;">
                            &#10006; Close Request
                        </button>
                    </span>
                </div>
                <table class="po-items-table">
                    <thead><tr><th>Item Code</th><th>Description</th><th>Qty</th><th>Truck(s)</th><th>Work Order</th></tr></thead>
                    <tbody>${item_rows || '<tr><td colspan="5" style="text-align:center;color:#9ca3af;">No items</td></tr>'}</tbody>
                </table>
            </div>`;
        }).join('');

        return `<div class="po-mr-list">${cards}</div>`;
    }

    // ── Aggregated Items tab ──────────────────────────────────────────────────

    _aggregate_items() {
        const agg = {};
        this.data.mr_items.forEach(i => {
            if (!agg[i.item_code]) {
                agg[i.item_code] = {
                    item_code: i.item_code,
                    item_name: i.item_name,
                    uom: i.uom,
                    total_qty: 0,
                    mrs: new Set(),
                    trucks: new Set(),
                };
            }
            agg[i.item_code].total_qty += flt(i.qty);
            agg[i.item_code].mrs.add(i.mr_name);
            if (i.trucks) i.trucks.split(',').forEach(t => agg[i.item_code].trucks.add(t.trim()));
        });
        return Object.values(agg).sort((a, b) => a.item_code.localeCompare(b.item_code));
    }

    _render_aggregate_tab() {
        const items = this._aggregate_items();
        if (!items.length) {
            return `<div class="po-empty">No production items found in active requests.</div>`;
        }

        const done_count = items.filter(i => this._produced.has(i.item_code)).length;

        const rows = items.map((it, idx) => {
            const done = this._produced.has(it.item_code);
            const truck_html = it.trucks.size
                ? Array.from(it.trucks).map(t => `<span class="po-truck-tag">&#128666; ${frappe.utils.escape_html(t)}</span>`).join(' ')
                : `<span style="color:#9ca3af;font-size:11px;">—</span>`;
            const mr_list = Array.from(it.mrs).map(m => frappe.utils.escape_html(m)).join(', ');
            return `<tr class="${done ? 'po-agg-done' : ''}" data-item="${frappe.utils.escape_html(it.item_code)}">
                <td>${idx + 1}</td>
                <td>
                    <strong>${frappe.utils.escape_html(it.item_code)}</strong>
                    ${done ? '<span class="po-done-badge">&#10003; Done</span>' : ''}
                </td>
                <td>${frappe.utils.escape_html(it.item_name || '')}</td>
                <td class="po-r"><strong>${flt(it.total_qty, 2)}</strong> ${frappe.utils.escape_html(it.uom || '')}</td>
                <td>${truck_html}</td>
                <td style="font-size:11px;color:#6b7280;">${mr_list}</td>
                <td>
                    <button class="btn btn-xs ${done ? 'btn-default po-unmark-btn' : 'btn-success po-mark-btn'}"
                        data-item="${frappe.utils.escape_html(it.item_code)}">
                        ${done ? 'Unmark' : '&#10003; Mark Produced'}
                    </button>
                </td>
            </tr>`;
        }).join('');

        return `<div>
            <div style="display:flex;gap:10px;margin-bottom:14px;align-items:center;flex-wrap:wrap;">
                <div class="po-mat-kpi po-mat-ok">&#10003; ${done_count} produced</div>
                <div class="po-mat-kpi po-mat-short">&#9744; ${items.length - done_count} pending</div>
                <div style="flex:1;"></div>
                <button class="btn btn-sm btn-default po-print-agg-btn">&#128438; Print List</button>
                <button class="btn btn-sm btn-default po-csv-btn">&#8659; Download CSV</button>
                ${done_count ? `<button class="btn btn-sm btn-default po-clear-produced-btn" style="color:#ef4444;">Clear All Produced</button>` : ''}
            </div>
            <div class="table-responsive">
                <table class="table table-bordered po-wo-table" id="po-agg-table">
                    <thead><tr>
                        <th width="4%">#</th>
                        <th width="14%">Item Code</th>
                        <th>Description</th>
                        <th class="po-r" width="12%">Total Qty</th>
                        <th width="18%">Truck(s)</th>
                        <th>From Requests</th>
                        <th width="110px">Status</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
    }

    // ── Work Orders tab ───────────────────────────────────────────────────────

    _render_workorders_tab() {
        const { work_orders } = this.data;
        if (!work_orders.length) {
            return `<div class="po-empty">No Work Orders linked to production requests yet.</div>`;
        }

        const rows = work_orders.map(wo => {
            const pct = wo.pct_complete || 0;
            const bar_color = wo.status === 'Completed' ? '#10b981'
                : pct > 50 ? '#3b82f6' : '#f59e0b';
            const status_color = {
                'Draft':       '#6b7280',
                'Submitted':   '#3b82f6',
                'Not Started': '#6b7280',
                'In Process':  '#f59e0b',
                'Completed':   '#10b981',
                'Stopped':     '#ef4444',
            }[wo.status] || '#6b7280';

            const short_count = (wo.bom_items || []).filter(b => b.shortfall > 0).length;
            const readiness_badge = wo.status === 'Completed'
                ? ''
                : wo.can_start
                    ? `<span class="po-ready-badge">&#10003; Ready</span>`
                    : `<span class="po-short-badge">&#9888; ${short_count} short</span>`;

            const action_btn = wo.status === 'Draft'
                ? `<button class="btn btn-xs btn-success po-submit-wo-btn" data-wo="${frappe.utils.escape_html(wo.name)}">Submit</button>`
                : wo.status === 'Completed' ? ''
                : `<a href="/app/work-order/${wo.name}" target="_blank" class="btn btn-xs btn-default">Open</a>`;

            return `<tr class="po-wo-row" data-wo="${frappe.utils.escape_html(wo.name)}">
                <td>
                    <a href="/app/work-order/${wo.name}" target="_blank" class="po-mr-link">
                        ${frappe.utils.escape_html(wo.name)}
                    </a>
                    ${wo.mr_name ? `<div style="font-size:10px;color:#9ca3af;margin-top:2px;">MR: ${frappe.utils.escape_html(wo.mr_name)}</div>` : ''}
                </td>
                <td>
                    <strong>${frappe.utils.escape_html(wo.production_item)}</strong>
                    <div style="font-size:11px;color:#6b7280;">${frappe.utils.escape_html(wo.item_name || '')}</div>
                </td>
                <td class="po-r">${flt(wo.qty, 2)}</td>
                <td class="po-r">${flt(wo.produced_qty, 2)}</td>
                <td>
                    <div class="po-progress-bar">
                        <div class="po-progress-fill" style="width:${pct}%;background:${bar_color};"></div>
                    </div>
                    <div style="font-size:10px;color:#6b7280;text-align:right;">${pct}%</div>
                </td>
                <td><span class="po-status-dot" style="background:${status_color};">${frappe.utils.escape_html(wo.status)}</span></td>
                <td>${readiness_badge}</td>
                <td>${action_btn}</td>
            </tr>
            <tr class="po-wo-detail-row" id="po-wo-detail-${frappe.utils.escape_html(wo.name)}" style="display:none;">
                <td colspan="8">${this._wo_detail_html(wo)}</td>
            </tr>`;
        }).join('');

        return `<div class="table-responsive">
            <table class="table table-bordered po-wo-table">
                <thead><tr>
                    <th>Work Order</th><th>Item</th>
                    <th class="po-r">Target Qty</th><th class="po-r">Produced</th>
                    <th width="120px">Progress</th><th>Status</th>
                    <th>Materials</th><th width="80px">Action</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }

    _wo_detail_html(wo) {
        if (!wo.bom_items || !wo.bom_items.length) {
            return `<div style="padding:12px;color:#9ca3af;">No BOM items found.</div>`;
        }
        const rows = wo.bom_items.map(b => {
            const ok = b.shortfall === 0;
            return `<tr style="${!ok ? 'background:#fef2f2;' : ''}">
                <td>${frappe.utils.escape_html(b.item_code)}</td>
                <td>${frappe.utils.escape_html(b.item_name || '')}</td>
                <td class="po-r">${flt(b.needed, 3)} ${frappe.utils.escape_html(b.uom || '')}</td>
                <td class="po-r">${flt(b.in_stock, 3)}</td>
                <td class="po-r" style="color:${ok ? '#10b981' : '#ef4444'};font-weight:600;">
                    ${ok ? '&#10003; OK' : `&#9888; Short ${flt(b.shortfall, 3)}`}
                </td>
            </tr>`;
        }).join('');

        return `<div style="padding:12px 20px;">
            <strong style="font-size:12px;color:#374151;">BOM / Raw Material Requirements</strong>
            <table class="table table-sm po-detail-table" style="margin-top:8px;">
                <thead><tr>
                    <th>Item Code</th><th>Description</th>
                    <th class="po-r">Required</th><th class="po-r">In Stock</th>
                    <th class="po-r">Status</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }

    // ── Material Readiness tab ────────────────────────────────────────────────

    _render_materials_tab() {
        const active_wos = this.data.work_orders.filter(w => w.status !== 'Completed');
        if (!active_wos.length) {
            return `<div class="po-empty">No active Work Orders to check materials for.</div>`;
        }

        const agg = {};
        active_wos.forEach(wo => {
            (wo.bom_items || []).forEach(b => {
                if (!agg[b.item_code]) {
                    agg[b.item_code] = { item_code: b.item_code, item_name: b.item_name, uom: b.uom, total_needed: 0, in_stock: b.in_stock };
                }
                agg[b.item_code].total_needed += b.needed;
                agg[b.item_code].in_stock = Math.max(agg[b.item_code].in_stock, b.in_stock);
            });
        });

        const items = Object.values(agg).sort((a, b) => {
            const sa = Math.max(0, a.total_needed - a.in_stock);
            const sb = Math.max(0, b.total_needed - b.in_stock);
            return sb - sa;
        });

        const rows = items.map((it, idx) => {
            const shortfall = Math.max(0, it.total_needed - it.in_stock);
            const ok = shortfall === 0;
            const pct = it.total_needed > 0 ? Math.min(100, (it.in_stock / it.total_needed) * 100) : 100;
            return `<tr style="${!ok ? 'background:#fef2f2;' : ''}">
                <td>${idx + 1}</td>
                <td><strong>${frappe.utils.escape_html(it.item_code)}</strong></td>
                <td>${frappe.utils.escape_html(it.item_name || '')}</td>
                <td class="po-r">${flt(it.total_needed, 2)} ${frappe.utils.escape_html(it.uom || '')}</td>
                <td class="po-r">${flt(it.in_stock, 2)}</td>
                <td class="po-r" style="color:${ok ? '#10b981' : '#ef4444'};font-weight:600;">
                    ${ok ? '&#10003; OK' : flt(shortfall, 2)}
                </td>
                <td>
                    <div class="po-progress-bar">
                        <div class="po-progress-fill" style="width:${pct.toFixed(0)}%;background:${ok ? '#10b981' : pct > 50 ? '#f59e0b' : '#ef4444'};"></div>
                    </div>
                </td>
            </tr>`;
        }).join('');

        const ok_count    = items.filter(it => it.total_needed <= it.in_stock).length;
        const short_count = items.length - ok_count;

        return `<div>
            <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
                <div class="po-mat-kpi po-mat-ok">&#10003; ${ok_count} item${ok_count !== 1 ? 's' : ''} sufficient</div>
                <div class="po-mat-kpi po-mat-short">&#9888; ${short_count} item${short_count !== 1 ? 's' : ''} short</div>
            </div>
            <div class="table-responsive">
                <table class="table table-bordered po-wo-table">
                    <thead><tr>
                        <th width="4%">#</th><th width="14%">Item Code</th><th>Description</th>
                        <th class="po-r" width="14%">Total Needed</th>
                        <th class="po-r" width="14%">In Stock</th>
                        <th class="po-r" width="12%">Shortfall</th>
                        <th width="16%">Coverage</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
    }

    // ── Colour Specs tab ─────────────────────────────────────────────────────

    _render_colours_tab() {
        const paint_orders = this.data.paint_orders || [];
        if (!paint_orders.length) {
            return `<div class="po-empty">No active orders have paint / colour notes at the moment.</div>`;
        }

        const cards = paint_orders.map(o => {
            const truck = o.custom_truck_number
                ? `<span class="po-colour-tag">&#128666; ${frappe.utils.escape_html(o.custom_truck_number)}</span>` : '';
            const region = o.custom_delivery_region
                ? `<span class="po-colour-tag">${frappe.utils.escape_html(o.custom_delivery_region)}</span>` : '';
            return `<div class="po-colour-card">
                <div class="po-colour-card-head">
                    <span>
                        <a href="/app/sales-order/${o.name}" target="_blank" class="po-mr-link">
                            ${frappe.utils.escape_html(o.name)}
                        </a>
                        <span class="po-colour-customer">${frappe.utils.escape_html(o.customer_name || '')}</span>
                    </span>
                    <span style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                        ${truck}${region}
                        <span style="font-size:11px;color:#92400e;">${frappe.datetime.str_to_user(o.transaction_date)}</span>
                        <span class="po-colour-state">${frappe.utils.escape_html(o.workflow_state || '')}</span>
                    </span>
                </div>
                <div class="po-colour-note">
                    &#9888;&nbsp;${frappe.utils.escape_html(o.custom_paint_notes)}
                </div>
            </div>`;
        }).join('');

        return `<div>
            <div style="margin-bottom:14px;font-size:13px;color:#78350f;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:10px 16px;">
                &#9888; <strong>${paint_orders.length} active order${paint_orders.length !== 1 ? 's' : ''}</strong> have paint or colour specifications. Ensure production team reads these before mixing.
            </div>
            <div class="po-colour-list">${cards}</div>
        </div>`;
    }

    // ── Print / Download ──────────────────────────────────────────────────────

    _print_aggregate() {
        const items = this._aggregate_items();
        const from_date = this.page.fields_dict.from_date.get_value() || '';
        const to_date   = this.page.fields_dict.to_date.get_value()   || '';
        const date_range = (from_date || to_date)
            ? ` (${from_date || '…'} → ${to_date || '…'})`
            : '';

        const rows = items.map((it, idx) => {
            const done = this._produced.has(it.item_code);
            const trucks = it.trucks.size ? Array.from(it.trucks).join(', ') : '—';
            return `<tr style="${done ? 'background:#f0fdf4;' : ''}">
                <td>${idx + 1}</td>
                <td>${it.item_code}</td>
                <td>${it.item_name || ''}</td>
                <td style="text-align:right;font-weight:bold;">${flt(it.total_qty, 2)} ${it.uom || ''}</td>
                <td>${trucks}</td>
                <td>${Array.from(it.mrs).join(', ')}</td>
                <td style="text-align:center;">${done ? '✓ Done' : ''}</td>
            </tr>`;
        }).join('');

        const html = `<!DOCTYPE html><html><head><title>Production List${date_range}</title>
        <style>
            body{font-family:Arial,sans-serif;font-size:12px;margin:20px;}
            h2{color:#1e293b;margin-bottom:4px;}
            .sub{color:#6b7280;font-size:11px;margin-bottom:16px;}
            table{width:100%;border-collapse:collapse;}
            th{background:#1e293b;color:#fff;padding:7px 10px;text-align:left;font-size:11px;}
            td{padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;}
            tr:last-child td{border-bottom:none;}
            .done{background:#f0fdf4 !important;}
            @media print{button{display:none;}}
        </style></head><body>
        <h2>Production List${date_range}</h2>
        <div class="sub">Generated ${frappe.datetime.now_datetime()} &nbsp;|&nbsp; ${items.length} items</div>
        <button onclick="window.print()" style="margin-bottom:14px;padding:6px 16px;background:#1e293b;color:#fff;border:none;border-radius:4px;cursor:pointer;">Print</button>
        <table>
            <thead><tr>
                <th>#</th><th>Item Code</th><th>Description</th>
                <th style="text-align:right;">Total Qty</th>
                <th>Truck(s)</th><th>Requests</th><th>Status</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table></body></html>`;

        const w = window.open('', '_blank');
        w.document.write(html);
        w.document.close();
    }

    _download_csv() {
        const items = this._aggregate_items();
        const from_date = this.page.fields_dict.from_date.get_value() || '';
        const to_date   = this.page.fields_dict.to_date.get_value()   || '';

        const esc = v => `"${String(v || '').replace(/"/g, '""')}"`;
        const header = ['#', 'Item Code', 'Description', 'Total Qty', 'UOM', 'Trucks', 'From Requests', 'Status'].map(esc).join(',');
        const body = items.map((it, idx) => [
            idx + 1,
            esc(it.item_code),
            esc(it.item_name || ''),
            flt(it.total_qty, 2),
            esc(it.uom || ''),
            esc(Array.from(it.trucks).join('; ')),
            esc(Array.from(it.mrs).join('; ')),
            esc(this._produced.has(it.item_code) ? 'Done' : 'Pending'),
        ].join(',')).join('\n');

        const csv = `﻿${header}\n${body}`;
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `production_list${from_date ? '_' + from_date : ''}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ── Produced tracking ─────────────────────────────────────────────────────

    _save_produced() {
        localStorage.setItem('po_produced', JSON.stringify([...this._produced]));
    }

    // ── Events ────────────────────────────────────────────────────────────────

    _attach_events() {
        const self = this;
        this.container.off('click.po-tabs').on('click.po-tabs', '.po-tab-btn', function () {
            self.active_tab = $(this).data('tab');
            self.container.find('.po-tab-btn').removeClass('po-tab-active');
            $(this).addClass('po-tab-active');
            self._render_active_tab();
        });
    }

    _attach_tab_events() {
        const self = this;

        // Expand/collapse WO detail rows
        this.container.find('.po-wo-row').off('click.po-expand').on('click.po-expand', function (e) {
            if ($(e.target).closest('button, a').length) return;
            const wo = $(this).data('wo');
            $(`#po-wo-detail-${wo}`).toggle();
        });

        // Create Work Order from MR item
        this.container.find('.po-create-wo-btn').off('click').on('click', function () {
            const mr   = $(this).data('mr');
            const item = $(this).data('item');
            const qty  = parseFloat($(this).data('qty')) || 1;
            self._show_create_wo_dialog(mr, item, qty);
        });

        // Submit Work Order
        this.container.find('.po-submit-wo-btn').off('click').on('click', function () {
            const wo = $(this).data('wo');
            frappe.confirm(__('Submit Work Order {0}?', [wo]), () => {
                frappe.call({
                    method: 'crystal_custom.crystal_customizations.page.production_overview.production_overview.submit_work_order',
                    args: { wo_name: wo },
                    callback: () => {
                        frappe.show_alert({ message: __('Work Order {0} submitted', [wo]), indicator: 'green' });
                        self.load();
                    },
                });
            });
        });

        // Close / Stop MR
        this.container.find('.po-close-mr-btn').off('click').on('click', function () {
            const mr = $(this).data('mr');
            frappe.confirm(
                __('Close production request {0}? It will be marked Stopped and removed from the active list.', [mr]),
                () => {
                    frappe.call({
                        method: 'crystal_custom.crystal_customizations.page.production_overview.production_overview.close_request',
                        args: { mr_name: mr },
                        callback: () => {
                            frappe.show_alert({ message: __('Request {0} closed', [mr]), indicator: 'green' });
                            self.load();
                        },
                    });
                }
            );
        });

        // Mark as produced
        this.container.find('.po-mark-btn').off('click').on('click', function () {
            const item = $(this).data('item');
            self._produced.add(item);
            self._save_produced();
            self._render_active_tab();
        });

        // Unmark produced
        this.container.find('.po-unmark-btn').off('click').on('click', function () {
            const item = $(this).data('item');
            self._produced.delete(item);
            self._save_produced();
            self._render_active_tab();
        });

        // Clear all produced
        this.container.find('.po-clear-produced-btn').off('click').on('click', function () {
            frappe.confirm(__('Clear all "produced" markings?'), () => {
                self._produced.clear();
                self._save_produced();
                self._render_active_tab();
            });
        });

        // Print aggregate
        this.container.find('.po-print-agg-btn').off('click').on('click', () => this._print_aggregate());

        // Download CSV
        this.container.find('.po-csv-btn').off('click').on('click', () => this._download_csv());
    }

    _show_create_wo_dialog(mr_name, item_code, qty) {
        const self = this;
        frappe.call({
            method: 'crystal_custom.crystal_customizations.page.production_overview.production_overview.get_bom_list',
            args: { item_code },
            callback: (r) => {
                const boms = r.message || [];
                const bom_options = boms.map(b => b.name);
                const default_bom = boms.find(b => b.is_default) || boms[0];

                const d = new frappe.ui.Dialog({
                    title: __('Create Work Order — {0}', [item_code]),
                    fields: [
                        { label: 'Item Code',        fieldname: 'item_code', fieldtype: 'Data',  default: item_code, read_only: 1 },
                        { label: 'Quantity',         fieldname: 'qty',       fieldtype: 'Float', default: qty, reqd: 1 },
                        { label: 'BOM',              fieldname: 'bom_no',    fieldtype: 'Select',
                          options: bom_options.join('\n'), default: default_bom ? default_bom.name : '', reqd: 1 },
                        { label: 'Material Request', fieldname: 'mr_name',   fieldtype: 'Data',  default: mr_name, read_only: 1 },
                    ],
                    primary_action_label: __('Create Work Order'),
                    primary_action(vals) {
                        frappe.call({
                            method: 'crystal_custom.crystal_customizations.page.production_overview.production_overview.create_work_order',
                            args: { mr_name: vals.mr_name, item_code: vals.item_code, qty: vals.qty, bom_no: vals.bom_no },
                            freeze: true,
                            freeze_message: __('Creating Work Order…'),
                            callback: (r) => {
                                d.hide();
                                if (r.message) {
                                    frappe.show_alert({
                                        message: __('Work Order <a href="/app/work-order/{0}" target="_blank">{0}</a> created', [r.message]),
                                        indicator: 'green',
                                    }, 8);
                                    self.load();
                                }
                            },
                        });
                    },
                });
                d.show();
            },
        });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _kpi_row(cards) {
        const items = cards.map(c => `
            <div class="po-kpi-card" style="background:linear-gradient(135deg, ${c.color});">
                <div class="po-kpi-val">${c.value}</div>
                <div class="po-kpi-label">${c.label}</div>
            </div>`).join('');
        return `<div class="po-kpi-row">${items}</div>`;
    }

    _styles() {
        return `<style>
            .po-container { padding: 16px; }
            .po-kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 20px; }
            .po-kpi-card { border-radius: 10px; padding: 18px 20px; color: #fff; }
            .po-kpi-val  { font-size: 28px; font-weight: 800; line-height: 1; }
            .po-kpi-label { font-size: 12px; opacity: .85; margin-top: 4px; }

            .po-tabs { display: flex; gap: 6px; border-bottom: 2px solid #e2e8f0; margin-bottom: 18px; flex-wrap: wrap; }
            .po-tab-btn { background: none; border: none; padding: 8px 16px; font-size: 13px; font-weight: 600;
                          color: #6b7280; cursor: pointer; border-bottom: 3px solid transparent; margin-bottom: -2px; }
            .po-tab-btn:hover  { color: #1e293b; }
            .po-tab-active     { color: #1e293b !important; border-bottom-color: #1e293b !important; }
            .po-tab-badge      { display: inline-block; background: #e2e8f0; color: #374151;
                                  border-radius: 10px; font-size: 10px; padding: 1px 7px; margin-left: 5px; }
            .po-tab-badge-warn { background: #fef3c7 !important; color: #92400e !important; }

            .po-mr-list { display: flex; flex-direction: column; gap: 16px; }
            .po-mr-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
            .po-mr-head { background: #1e293b; color: #f1f5f9; padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
            .po-mr-link { color: #93c5fd !important; font-weight: 700; text-decoration: none; }
            .po-mr-link:hover { color: #bfdbfe !important; }
            .po-items-table { width: 100%; border-collapse: collapse; font-size: 13px; }
            .po-items-table th { background: #f8fafc; padding: 8px 12px; font-size: 11px; text-align: left;
                                  border-bottom: 1px solid #e2e8f0; color: #475569; }
            .po-items-table td { padding: 9px 12px; border-bottom: 1px solid #f1f5f9; }
            .po-items-table tr:last-child td { border-bottom: none; }

            .po-truck-tag { font-size: 10px; background: #ede9fe; color: #5b21b6; border-radius: 10px; padding: 2px 8px; font-weight: 600; white-space: nowrap; }
            .po-status-dot { font-size: 11px; padding: 2px 8px; border-radius: 10px; color: #fff; font-weight: 600; white-space: nowrap; }
            .po-wo-badge   { font-size: 10px; background: #dcfce7; color: #166534; border: 1px solid #86efac;
                              border-radius: 10px; padding: 2px 7px; }
            .po-ready-badge { font-size: 11px; background: #dcfce7; color: #166534; border-radius: 10px; padding: 2px 8px; font-weight: 600; white-space: nowrap; }
            .po-short-badge { font-size: 11px; background: #fef2f2; color: #991b1b; border-radius: 10px; padding: 2px 8px; font-weight: 600; white-space: nowrap; }
            .po-done-badge  { font-size: 10px; background: #dcfce7; color: #166534; border-radius: 10px; padding: 1px 7px; margin-left: 6px; font-weight: 600; }

            .po-wo-table { font-size: 13px; }
            .po-wo-table th { background: #1e293b; color: #f1f5f9; padding: 9px 12px; border: none !important; font-size: 11px; }
            .po-wo-table td { padding: 9px 12px; vertical-align: middle; }
            .po-wo-row    { cursor: pointer; }
            .po-wo-row:hover td { background: #f8fafc; }
            .po-r { text-align: right !important; }

            .po-agg-done td { background: #f0fdf4 !important; color: #166534; }

            .po-progress-bar  { height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden; }
            .po-progress-fill { height: 100%; border-radius: 3px; transition: width .3s; }

            .po-detail-table { font-size: 12px; }
            .po-detail-table th { background: #334155; color: #f1f5f9; padding: 6px 10px; font-size: 11px; }
            .po-detail-table td { padding: 7px 10px; }

            .po-mat-kpi       { padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; }
            .po-mat-ok        { background: #dcfce7; color: #166534; }
            .po-mat-short     { background: #fef2f2; color: #991b1b; }
            .po-empty         { padding: 40px; text-align: center; color: #9ca3af; font-size: 14px; }

            .po-colour-list { display: flex; flex-direction: column; gap: 12px; }
            .po-colour-card { border: 2px solid #f59e0b; border-radius: 8px; overflow: hidden; background: #fff; box-shadow: 0 2px 6px rgba(245,158,11,.15); }
            .po-colour-card-head { background: #fef3c7; padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; border-bottom: 1px solid #fcd34d; }
            .po-colour-customer { font-size: 13px; color: #78350f; margin-left: 10px; font-weight: 600; }
            .po-colour-note { padding: 12px 16px; font-size: 14px; color: #78350f; font-weight: 600; background: #fffbeb; line-height: 1.6; white-space: pre-wrap; }
            .po-colour-tag  { font-size: 10px; background: #f59e0b; color: #fff; border-radius: 10px; padding: 2px 8px; font-weight: 600; }
            .po-colour-state { font-size: 10px; background: #e2e8f0; color: #374151; border-radius: 10px; padding: 2px 8px; }

            @media (max-width: 768px) { .po-kpi-row { grid-template-columns: repeat(2, 1fr); } }
        </style>`;
    }
}
