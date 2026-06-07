frappe.pages['route-planner'].on_page_load = function (wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'Route Planner',
        single_column: true
    });
    new RoutePlanner(page);
};

/* ─────────────────────────────────────────────────────────────────────────── */
/* Leaflet loader                                                               */
/* ─────────────────────────────────────────────────────────────────────────── */
function load_leaflet(cb) {
    if (window.L) { cb(); return; }

    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);

    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = cb;
    document.head.appendChild(js);
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* RoutePlanner class                                                           */
/* ─────────────────────────────────────────────────────────────────────────── */
class RoutePlanner {
    constructor(page) {
        this.page = page;
        this.orders = [];           // all pending orders from server
        this.selected_orders = [];  // orders added to this route
        this.waypoints = [];        // [{lat, lng, label, marker, idx}]
        this.map = null;
        this.polyline = null;
        this.current_route_name = null; // name of loaded/saved doc
        this.region_filter = '';

        this._setup_toolbar();
        this._build_layout();
        load_leaflet(() => {
            this._init_map();
            this.load_orders();
        });
    }

    /* ── toolbar ─────────────────────────────────────────────────────────── */
    _setup_toolbar() {
        // Route name input
        this.page.add_field({
            label: 'Route Name',
            fieldtype: 'Data',
            fieldname: 'route_name',
            placeholder: 'e.g. Nairobi North Route 1'
        });

        // Truck type
        this.page.add_field({
            label: 'Truck Type',
            fieldtype: 'Select',
            fieldname: 'truck_type',
            options: '\n3 Tonner\n5 Tonner\n10 Tonner'
        });

        // Truck number / plate
        this.page.add_field({
            label: 'Truck No / Plate',
            fieldtype: 'Data',
            fieldname: 'truck_number',
            placeholder: 'e.g. KCA 123T'
        });

        // Route date
        this.page.add_field({
            label: 'Route Date',
            fieldtype: 'Date',
            fieldname: 'route_date',
            default: frappe.datetime.get_today()
        });

        // Primary action → Save
        this.page.set_primary_action('Save Route', () => this._save_route(), 'octicon octicon-check');

        this.page.add_button('Submit Route', () => this._submit_route(), 'octicon octicon-cloud-upload');
        this.page.add_button('Load Existing', () => this._load_existing_dialog(), 'octicon octicon-repo');
        this.page.add_button('Refresh Orders', () => this.load_orders(), 'octicon octicon-sync');
        this.page.add_button('Clear Map', () => this._clear_map(), 'octicon octicon-trashcan');
    }

    /* ── layout ──────────────────────────────────────────────────────────── */
    _build_layout() {
        const html = `
        <div class="rp-wrap">
            <!-- LEFT: orders panel -->
            <div class="rp-orders-panel">
                <div class="rp-panel-header">
                    <span class="rp-panel-title">📦 Pending Orders</span>
                    <input class="form-control form-control-sm rp-search"
                           placeholder="Filter by customer / region…" />
                </div>
                <div class="rp-orders-list" id="rp-orders-list">
                    <div class="rp-loading">Loading orders…</div>
                </div>
            </div>

            <!-- RIGHT: map + waypoints -->
            <div class="rp-right-panel">
                <div class="rp-map-header">
                    <span class="rp-hint">🖱 Click on the map to add waypoints · Drag a marker to reposition · Right-click a marker to remove it</span>
                    <span class="rp-wp-count" id="rp-wp-count">0 waypoints</span>
                </div>
                <div id="rp-map"></div>
                <div class="rp-waypoints-section">
                    <div class="rp-wp-header">
                        <strong>Route Waypoints</strong>
                        <button class="btn btn-xs btn-danger rp-clear-wp">Clear All</button>
                    </div>
                    <div id="rp-waypoints-list" class="rp-waypoints-list">
                        <span class="text-muted">No waypoints yet — click the map to begin.</span>
                    </div>
                </div>
            </div>
        </div>

        <style>
            /* ── Layout ── */
            .rp-wrap {
                display: flex;
                height: calc(100vh - 170px);
                min-height: 520px;
                gap: 0;
                margin-top: 10px;
                border: 1px solid #d1d8dd;
                border-radius: 8px;
                overflow: hidden;
            }

            /* ── Left panel ── */
            .rp-orders-panel {
                width: 340px;
                min-width: 280px;
                display: flex;
                flex-direction: column;
                border-right: 1px solid #d1d8dd;
                background: #fafbfc;
            }
            .rp-panel-header {
                padding: 10px 12px 8px;
                border-bottom: 1px solid #d1d8dd;
                background: #f0f4f7;
            }
            .rp-panel-title {
                font-weight: 600;
                font-size: 13px;
                display: block;
                margin-bottom: 6px;
            }
            .rp-search {
                font-size: 12px;
            }
            .rp-orders-list {
                flex: 1;
                overflow-y: auto;
                padding: 8px;
            }
            .rp-loading {
                color: #888;
                padding: 20px;
                text-align: center;
                font-size: 13px;
            }

            /* Order card */
            .rp-order-card {
                background: white;
                border: 1px solid #e0e6ec;
                border-radius: 6px;
                padding: 8px 10px;
                margin-bottom: 6px;
                cursor: pointer;
                transition: border-color .15s, background .15s;
                font-size: 12px;
            }
            .rp-order-card:hover { border-color: #5e64ff; }
            .rp-order-card.selected {
                background: #e8f0fe;
                border-color: #5e64ff;
            }
            .rp-order-card .rp-oc-name {
                font-weight: 600;
                color: #2c3e50;
                display: flex;
                justify-content: space-between;
            }
            .rp-order-card .rp-oc-customer { color: #444; margin-top: 2px; }
            .rp-order-card .rp-oc-meta {
                color: #777;
                margin-top: 3px;
                display: flex;
                gap: 10px;
            }
            .rp-badge-selected {
                background: #5e64ff;
                color: white;
                border-radius: 3px;
                padding: 1px 5px;
                font-size: 10px;
            }

            /* ── Right panel ── */
            .rp-right-panel {
                flex: 1;
                display: flex;
                flex-direction: column;
                min-width: 0;
            }
            .rp-map-header {
                padding: 6px 12px;
                background: #f0f4f7;
                border-bottom: 1px solid #d1d8dd;
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 11px;
                color: #555;
            }
            .rp-wp-count {
                font-weight: 600;
                color: #2c3e50;
            }
            #rp-map {
                flex: 1;
                min-height: 340px;
            }

            /* ── Waypoints section ── */
            .rp-waypoints-section {
                height: 160px;
                overflow-y: auto;
                border-top: 1px solid #d1d8dd;
                background: #fafbfc;
                padding: 8px 12px;
            }
            .rp-wp-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 6px;
                font-size: 12px;
            }
            .rp-waypoints-list { font-size: 12px; }
            .rp-wp-row {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 4px 0;
                border-bottom: 1px solid #eee;
            }
            .rp-wp-row:last-child { border-bottom: none; }
            .rp-wp-num {
                background: #5e64ff;
                color: white;
                border-radius: 50%;
                width: 20px;
                height: 20px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 10px;
                font-weight: 700;
                flex-shrink: 0;
            }
            .rp-wp-coords { flex: 1; color: #444; }
            .rp-wp-label { color: #5e64ff; font-style: italic; min-width: 80px; }
            .rp-wp-remove {
                color: #e74c3c;
                cursor: pointer;
                font-size: 14px;
                line-height: 1;
                padding: 2px 5px;
                border-radius: 3px;
            }
            .rp-wp-remove:hover { background: #fde8e8; }

            /* Leaflet numbered icon */
            .rp-num-icon {
                background: #5e64ff;
                color: white;
                border-radius: 50%;
                width: 28px !important;
                height: 28px !important;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 12px;
                font-weight: 700;
                border: 2px solid white;
                box-shadow: 0 2px 6px rgba(0,0,0,.4);
            }
        </style>`;

        this.container = $('<div>').appendTo(this.page.main);
        this.container.html(html);

        // Wire static events
        this.container.find('.rp-clear-wp').on('click', () => this._clear_map());
        this.container.find('.rp-search').on('input', (e) => this._filter_orders(e.target.value));
    }

    /* ── map ─────────────────────────────────────────────────────────────── */
    _init_map() {
        // Kenya centre + reasonable zoom
        this.map = L.map('rp-map', {
            center: [0.0236, 37.9062],
            zoom: 7,
            maxBounds: [[-5.5, 33.5], [5.5, 42.5]],
            maxBoundsViscosity: 0.8
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
            maxZoom: 18
        }).addTo(this.map);

        this.map.on('click', (e) => this._add_waypoint(e.latlng.lat, e.latlng.lng));
    }

    _numbered_icon(n) {
        return L.divIcon({
            className: '',
            html: `<div class="rp-num-icon">${n}</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
            popupAnchor: [0, -16]
        });
    }

    _add_waypoint(lat, lng, label) {
        const idx = this.waypoints.length + 1;
        label = label || `Stop ${idx}`;

        const marker = L.marker([lat, lng], {
            icon: this._numbered_icon(idx),
            draggable: true
        }).addTo(this.map);

        marker.bindPopup(`<b>${label}</b><br>${lat.toFixed(5)}, ${lng.toFixed(5)}`);

        // Update coords on drag end
        marker.on('dragend', (e) => {
            const wp = this.waypoints.find(w => w.marker === marker);
            if (wp) {
                const pos = e.target.getLatLng();
                wp.lat = pos.lat;
                wp.lng = pos.lng;
                marker.setPopupContent(`<b>${wp.label}</b><br>${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)}`);
                this._redraw_polyline();
                this._render_waypoints_list();
            }
        });

        // Right-click to remove
        marker.on('contextmenu', () => {
            const wp = this.waypoints.find(w => w.marker === marker);
            if (wp) this._remove_waypoint(wp.idx);
        });

        const wp = { lat, lng, label, marker, idx };
        this.waypoints.push(wp);

        this._redraw_polyline();
        this._render_waypoints_list();
    }

    _remove_waypoint(idx) {
        const i = this.waypoints.findIndex(w => w.idx === idx);
        if (i === -1) return;
        this.map.removeLayer(this.waypoints[i].marker);
        this.waypoints.splice(i, 1);
        // Re-number remaining
        this.waypoints.forEach((w, pos) => {
            w.idx = pos + 1;
            w.marker.setIcon(this._numbered_icon(pos + 1));
        });
        this._redraw_polyline();
        this._render_waypoints_list();
    }

    _redraw_polyline() {
        if (this.polyline) this.map.removeLayer(this.polyline);
        if (this.waypoints.length < 2) { this.polyline = null; return; }
        const latlngs = this.waypoints.map(w => [w.lat, w.lng]);
        this.polyline = L.polyline(latlngs, {
            color: '#5e64ff',
            weight: 3,
            opacity: 0.85,
            dashArray: '6 4'
        }).addTo(this.map);
    }

    _clear_map() {
        this.waypoints.forEach(w => this.map.removeLayer(w.marker));
        this.waypoints = [];
        if (this.polyline) { this.map.removeLayer(this.polyline); this.polyline = null; }
        this._render_waypoints_list();
    }

    _render_waypoints_list() {
        const $list = this.container.find('#rp-waypoints-list');
        this.container.find('#rp-wp-count').text(`${this.waypoints.length} waypoint${this.waypoints.length !== 1 ? 's' : ''}`);

        if (!this.waypoints.length) {
            $list.html('<span class="text-muted">No waypoints yet — click the map to begin.</span>');
            return;
        }

        let html = '';
        this.waypoints.forEach(w => {
            html += `
                <div class="rp-wp-row" data-idx="${w.idx}">
                    <span class="rp-wp-num">${w.idx}</span>
                    <input class="form-control form-control-sm rp-wp-label-input"
                           style="width:120px;font-size:11px;"
                           value="${frappe.utils.escape_html(w.label)}"
                           data-idx="${w.idx}"
                           placeholder="Stop name" />
                    <span class="rp-wp-coords">${w.lat.toFixed(5)}, ${w.lng.toFixed(5)}</span>
                    <span class="rp-wp-remove" data-idx="${w.idx}" title="Remove waypoint">✕</span>
                </div>`;
        });
        $list.html(html);

        $list.find('.rp-wp-remove').on('click', (e) => {
            this._remove_waypoint(parseInt($(e.currentTarget).data('idx')));
        });

        $list.find('.rp-wp-label-input').on('change', (e) => {
            const idx = parseInt($(e.currentTarget).data('idx'));
            const wp = this.waypoints.find(w => w.idx === idx);
            if (wp) {
                wp.label = e.target.value;
                wp.marker.setPopupContent(`<b>${wp.label}</b><br>${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)}`);
            }
        });
    }

    /* ── orders list ─────────────────────────────────────────────────────── */
    load_orders() {
        this.container.find('#rp-orders-list').html('<div class="rp-loading">Loading…</div>');
        frappe.call({
            method: 'crystal_custom.crystal_customizations.page.route_planner.route_planner.get_pending_orders',
            callback: (r) => {
                this.orders = r.message || [];
                this._render_orders_list(this.orders);
            }
        });
    }

    _render_orders_list(orders) {
        const $list = this.container.find('#rp-orders-list');
        if (!orders.length) {
            $list.html('<div class="rp-loading">No orders in "Proceed to Order" state.</div>');
            return;
        }

        let html = '';
        orders.forEach(o => {
            const is_selected = this.selected_orders.some(s => s.name === o.name);
            html += `
                <div class="rp-order-card ${is_selected ? 'selected' : ''}" data-name="${o.name}">
                    <div class="rp-oc-name">
                        <a href="/app/sales-order/${o.name}" target="_blank"
                           onclick="event.stopPropagation();">${o.name}</a>
                        ${is_selected ? '<span class="rp-badge-selected">✓ Added</span>' : ''}
                    </div>
                    <div class="rp-oc-customer">${o.customer_name || o.customer}</div>
                    <div class="rp-oc-meta">
                        <span>📍 ${o.custom_delivery_region || '—'}</span>
                        <span>⚖ ${(o.total_net_weight || 0).toFixed(0)} kg</span>
                        <span>${format_currency(o.grand_total)}</span>
                    </div>
                </div>`;
        });
        $list.html(html);

        $list.find('.rp-order-card').on('click', (e) => {
            const name = $(e.currentTarget).data('name');
            this._toggle_order(name);
        });
    }

    _toggle_order(name) {
        const order = this.orders.find(o => o.name === name);
        if (!order) return;
        const idx = this.selected_orders.findIndex(o => o.name === name);
        if (idx === -1) {
            this.selected_orders.push(order);
        } else {
            this.selected_orders.splice(idx, 1);
        }
        // Re-render only the visible (filtered) list
        const search = this.container.find('.rp-search').val() || '';
        this._filter_orders(search);
    }

    _filter_orders(term) {
        if (!term) {
            this._render_orders_list(this.orders);
            return;
        }
        const lc = term.toLowerCase();
        const filtered = this.orders.filter(o =>
            (o.name || '').toLowerCase().includes(lc) ||
            (o.customer_name || '').toLowerCase().includes(lc) ||
            (o.customer || '').toLowerCase().includes(lc) ||
            (o.custom_delivery_region || '').toLowerCase().includes(lc)
        );
        this._render_orders_list(filtered);
    }

    /* ── save / submit ───────────────────────────────────────────────────── */
    _get_form_values() {
        return {
            route_name: this.page.fields_dict.route_name.get_value(),
            truck_type: this.page.fields_dict.truck_type.get_value(),
            truck_number: this.page.fields_dict.truck_number.get_value(),
            route_date: this.page.fields_dict.route_date.get_value()
        };
    }

    _validate_form(v) {
        if (!v.route_name) { frappe.msgprint('Please enter a Route Name.'); return false; }
        if (!v.truck_type) { frappe.msgprint('Please select a Truck Type.'); return false; }
        if (!v.truck_number) { frappe.msgprint('Please enter the Truck Number / Plate.'); return false; }
        if (!this.selected_orders.length) { frappe.msgprint('Please add at least one order to the route.'); return false; }
        if (!this.waypoints.length) { frappe.msgprint('Please add at least one waypoint on the map.'); return false; }
        return true;
    }

    _save_route() {
        const v = this._get_form_values();
        if (!this._validate_form(v)) return;

        const wp_data = this.waypoints.map(w => ({ lat: w.lat, lng: w.lng, label: w.label }));
        const order_data = this.selected_orders.map(o => ({
            sales_order: o.name,
            customer_name: o.customer_name || o.customer,
            delivery_region: o.custom_delivery_region || '',
            grand_total: o.grand_total || 0,
            total_net_weight: o.total_net_weight || 0
        }));

        frappe.call({
            method: 'crystal_custom.crystal_customizations.page.route_planner.route_planner.save_route',
            args: {
                route_name: v.route_name,
                truck_type: v.truck_type,
                truck_number: v.truck_number,
                route_date: v.route_date || frappe.datetime.get_today(),
                route_points: JSON.stringify(wp_data),
                orders: JSON.stringify(order_data),
                existing_name: this.current_route_name || null
            },
            callback: (r) => {
                if (r.message) {
                    this.current_route_name = r.message;
                    frappe.show_alert({ message: `Route "${r.message}" saved.`, indicator: 'green' });
                    this._update_submit_button_state('draft');
                }
            }
        });
    }

    _submit_route() {
        if (!this.current_route_name) {
            frappe.msgprint('Please save the route first before submitting.');
            return;
        }

        frappe.confirm(
            `Submit route <b>${this.current_route_name}</b>?<br><br>
             Once submitted the route will be locked and cannot be edited.`,
            () => {
                frappe.call({
                    method: 'crystal_custom.crystal_customizations.page.route_planner.route_planner.submit_route',
                    args: { name: this.current_route_name },
                    callback: (r) => {
                        if (r.message) {
                            frappe.show_alert({
                                message: `Route "${r.message}" submitted successfully.`,
                                indicator: 'green'
                            });
                            this._update_submit_button_state('submitted');
                        }
                    }
                });
            }
        );
    }

    _update_submit_button_state(state) {
        if (state === 'submitted') {
            this.page.set_primary_action('✓ Submitted', null, 'octicon octicon-check');
            this.page.btn_primary.prop('disabled', true);
        }
    }

    /* ── load existing ───────────────────────────────────────────────────── */
    _load_existing_dialog() {
        frappe.call({
            method: 'crystal_custom.crystal_customizations.page.route_planner.route_planner.get_draft_routes',
            callback: (r) => {
                const routes = r.message || [];
                if (!routes.length) {
                    frappe.msgprint('No saved draft routes found.');
                    return;
                }

                const options = routes.map(rt =>
                    `${rt.name} | ${rt.truck_type} | ${rt.truck_number} | ${rt.status} | ${rt.total_orders || 0} orders`
                );

                frappe.prompt([{
                    label: 'Select Route',
                    fieldname: 'route',
                    fieldtype: 'Select',
                    options: options.join('\n'),
                    reqd: 1
                }], (vals) => {
                    const name = vals.route.split(' | ')[0];
                    this._load_route(name);
                }, 'Load Saved Route', 'Load');
            }
        });
    }

    _load_route(name) {
        frappe.call({
            method: 'crystal_custom.crystal_customizations.page.route_planner.route_planner.get_route',
            args: { name },
            callback: (r) => {
                const doc = r.message;
                if (!doc) return;

                // Populate toolbar fields
                this.page.fields_dict.route_name.set_value(doc.route_name);
                this.page.fields_dict.truck_type.set_value(doc.truck_type);
                this.page.fields_dict.truck_number.set_value(doc.truck_number);
                this.page.fields_dict.route_date.set_value(doc.route_date);
                this.current_route_name = doc.name;

                // Restore selected orders
                this.selected_orders = (doc.orders || []).map(row => ({
                    name: row.sales_order,
                    customer_name: row.customer_name,
                    custom_delivery_region: row.delivery_region,
                    grand_total: row.grand_total,
                    total_net_weight: row.total_net_weight
                }));
                this._filter_orders('');

                // Restore waypoints
                this._clear_map();
                let pts = [];
                try { pts = JSON.parse(doc.route_points || '[]'); } catch (e) { pts = []; }
                pts.forEach(p => this._add_waypoint(p.lat, p.lng, p.label));

                // Fit map to waypoints
                if (this.waypoints.length) {
                    this.map.fitBounds(
                        L.latLngBounds(this.waypoints.map(w => [w.lat, w.lng])).pad(0.2)
                    );
                }

                if (doc.docstatus === 1) {
                    this._update_submit_button_state('submitted');
                    frappe.msgprint({ message: 'This route is submitted and read-only.', indicator: 'blue' });
                } else {
                    this.page.set_primary_action('Save Route', () => this._save_route(), 'octicon octicon-check');
                }

                frappe.show_alert({ message: `Loaded route: ${doc.name}`, indicator: 'green' });
            }
        });
    }
}
