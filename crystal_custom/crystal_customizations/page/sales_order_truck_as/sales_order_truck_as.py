import frappe
import json
import requests
from frappe.utils import flt
from frappe import _

CRYSTAL_API_BASE_URL = "https://crystal-api.crystalapps.dev"

CRYSTAL_API_INTERNAL_SECRET = frappe.conf.get("crystal_api_internal_secret")

@frappe.whitelist()
def calculate_route_proxy(coordinates_json):
    """
    Server-side proxy for Crystal API's /calculate-route. Browser-side JS
    (the route panel's _execute_route_mapping and the margin analyzer's
    _execute_margin_analysis) call this Frappe method instead of hitting
    Crystal API directly — a secret embedded in client-side JS is visible
    in dev tools and can never be trusted as a real secret, so only this
    server-side proxy is allowed to attach CRYSTAL_API_INTERNAL_SECRET.
    """
    coordinates = frappe.parse_json(coordinates_json) if isinstance(coordinates_json, str) else coordinates_json

    try:
        resp = requests.post(
            f"{CRYSTAL_API_BASE_URL}/calculate-route",
            json={"coordinates": coordinates},
            headers={"x-internal-secret": CRYSTAL_API_INTERNAL_SECRET or ""},
            timeout=20
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        frappe.log_error(f"calculate_route_proxy failed: {e}", "Truck Assignment Route Proxy")
        return {"error": str(e)}

@frappe.whitelist()
def get_truck_assignment_orders(from_date=None, to_date=None, sales_persons_json=None, regions_json=None):
    """
    Return truck-assigned and unassigned orders for the Truck Assignment page.
    Filters (Date, SP, Region) now ONLY apply to Unassigned Orders (Awaiting Planning)
    to prevent pulling history data and recreating closed truck drafts.
    """
    sps     = json.loads(sales_persons_json) if sales_persons_json else []
    regions = json.loads(regions_json)        if regions_json        else []

    has_pf = frappe.db.has_column('Sales Order', 'custom_is_pre_fulfillment')
    pf_expr = (
        'IFNULL(so.custom_is_pre_fulfillment, 0) AS custom_is_pre_fulfillment'
        if has_pf else '0 AS custom_is_pre_fulfillment'
    )

    WF = ('Proceed To Order', 'Pending Finance Approval', 'Pending Customer Order Reconfirmation', 'Order Confirmed')

    sp_join  = ''
    sp_where = ''
    params   = {'wf': WF}
    
    if sps:
        sp_join  = 'INNER JOIN `tabSales Team` st ON st.parent = so.name AND st.parenttype = "Sales Order"'
        sp_ph    = ', '.join([f'%(sp{i})s' for i in range(len(sps))])
        sp_where = f'AND st.sales_person IN ({sp_ph})'
        for i, sp in enumerate(sps):
            params[f'sp{i}'] = sp

    select_cols = f"""
        so.name, so.customer, so.customer_name, so.transaction_date,
        so.grand_total, so.custom_delivery_region, so.owner,
        so.custom_truck_number, so.total_net_weight,
        IFNULL(so.custom_call_not_picked, 0) AS custom_call_not_picked,
        so.custom_call_notes,
        so.workflow_state, so.docstatus,
        {pf_expr},
        IFNULL(c.custom_latitude, 0.0) AS custom_latitude,
        IFNULL(c.custom_longitude, 0.0) AS custom_longitude,
        (SELECT GROUP_CONCAT(DISTINCT st2.sales_person
                             ORDER BY st2.sales_person SEPARATOR ', ')
         FROM `tabSales Team` st2
         WHERE st2.parent = so.name) AS sales_persons
    """

    # Filters apply ONLY to unassigned (Awaiting Planning) pool
    unassigned_filters = ''
    if from_date:
        params['from_date'] = from_date
        unassigned_filters += ' AND DATE(so.transaction_date) >= %(from_date)s'
    if to_date:
        params['to_date'] = to_date
        unassigned_filters += ' AND DATE(so.transaction_date) <= %(to_date)s'
    if regions:
        rph = ', '.join([f'%(rgn{i})s' for i in range(len(regions))])
        unassigned_filters += f' AND so.custom_delivery_region IN ({rph})'
        for i, r in enumerate(regions):
            params[f'rgn{i}'] = r

    # Assigned Query: Strictly fetch orders that are in an ACTIVE draft truck plan. 
    # This prevents UI bugs that generate ghost trucks from historical data.
    assigned = frappe.db.sql(f"""
        SELECT DISTINCT {select_cols}
        FROM `tabSales Order` so 
        LEFT JOIN `tabCustomer` c ON so.customer = c.name
        WHERE so.docstatus IN (0, 1)
          AND so.custom_truck_number IS NOT NULL
          AND so.custom_truck_number != ''
          AND EXISTS (SELECT 1 FROM `tabCrystal Truck Plan` WHERE truck_number = so.custom_truck_number AND docstatus = 0)
        ORDER BY so.transaction_date DESC
        LIMIT 500
    """, params, as_dict=1)

    # Unassigned Query: Awaiting Planning honors all Date/SP/Region filters
    unassigned = frappe.db.sql(f"""
        SELECT DISTINCT {select_cols}
        FROM `tabSales Order` so 
        LEFT JOIN `tabCustomer` c ON so.customer = c.name
        {sp_join}
        WHERE so.docstatus IN (0, 1)
          AND (so.docstatus = 1 OR so.workflow_state IN %(wf)s)
          AND so.status NOT IN ('Completed', 'Closed')
          AND (so.custom_truck_number IS NULL OR so.custom_truck_number = '')
          {sp_where}
          {unassigned_filters}
        ORDER BY so.transaction_date DESC
        LIMIT 1000
    """, params, as_dict=1)

    return {'assigned': [dict(r) for r in assigned], 'unassigned': [dict(r) for r in unassigned]}


# ─── MASTER CONTROLLER: DOC-TYPE LIFECYCLE ──────────────────────────────────────

@frappe.whitelist()
def sync_missing_active_trucks(truck_numbers_json):
    """
    Bulk creates missing Draft Crystal Truck Plans sequentially.
    This prevents Naming Series deadlocks caused by concurrent asynchronous API calls.
    """
    truck_numbers = json.loads(truck_numbers_json)
    created_trucks = []

    for truck_number in truck_numbers:
        if not truck_number:
            continue
            
        # Ensure we don't duplicate existing active trucks
        if not frappe.db.exists('Crystal Truck Plan', {'truck_number': truck_number, 'docstatus': 0}):
            doc = frappe.new_doc('Crystal Truck Plan')
            doc.truck_number = truck_number
            doc.driver_name = ''
            doc.capacity_kg = None # Update: Field is now a Link to Vehicle Type
            doc.warehouse_status = 'Pending'  # NEW: Enforce Segregation of Duties state
            doc.insert(ignore_permissions=True)
            created_trucks.append(truck_number)

    return created_trucks


@frappe.whitelist()
def add_active_truck(truck_number, driver_name='', capacity_kg=None):
    """Instantiates a Draft Crystal Truck Plan immediately upon UI creation."""
    if frappe.db.exists('Crystal Truck Plan', {'truck_number': truck_number, 'docstatus': 0}):
        return False # Prevent duplicates
    
    doc = frappe.new_doc('Crystal Truck Plan')
    doc.truck_number = truck_number
    doc.driver_name = driver_name
    doc.capacity_kg = capacity_kg # Update: capacity_kg now holds the string Link for Vehicle Type
    doc.warehouse_status = 'Pending'  # NEW: Enforce Segregation of Duties state
    doc.insert(ignore_permissions=True)
    return doc.name


@frappe.whitelist()
def update_active_truck(truck_number, driver_name='', capacity_kg=None):
    """Updates meta details directly on the Draft Doctype."""
    name = frappe.db.get_value('Crystal Truck Plan', {'truck_number': truck_number, 'docstatus': 0}, 'name')
    if name:
        frappe.db.set_value('Crystal Truck Plan', name, {
            'driver_name': driver_name,
            'capacity_kg': capacity_kg # Update: Assigns Vehicle Type name
        })
    return True


@frappe.whitelist()
def delete_active_truck(truck_number):
    """Deletes the Draft plan. Frappe handles cascading deletions of child tables instantly."""
    name = frappe.db.get_value('Crystal Truck Plan', {'truck_number': truck_number, 'docstatus': 0}, 'name')
    if name:
        frappe.delete_doc('Crystal Truck Plan', name, ignore_permissions=True)
    return True


@frappe.whitelist()
def get_active_trucks():
    """Feeds the active UI tabs directly from the Database."""
    trucks = frappe.get_all('Crystal Truck Plan',
        filters={'docstatus': 0},
        fields=['truck_number', 'driver_name', 'capacity_kg', 'name as trip_id', 'warehouse_status']
    )
    
    # UPDATE: Fetch the actual float capacity from the linked Vehicle Type for UI utilization math
    for t in trucks:
        if t.get('capacity_kg'):
            t['max_tonnage'] = frappe.db.get_value('Vehicle Type', t['capacity_kg'], 'max_tonnage') or 0.0
        else:
            t['max_tonnage'] = 0.0
            
    return trucks


@frappe.whitelist()
def get_dispatched_trucks():
    """Dynamically builds the Trip History directly from submitted DocTypes."""
    plans = frappe.get_all('Crystal Truck Plan',
        filters={'docstatus': 1},
        fields=['truck_number', 'driver_name', 'capacity_kg', 'name as trip_id', 'modified as closed_at', 'warehouse_status'],
        order_by='modified DESC',
        limit=50
    )
    result = []
    for p in plans:
        doc = frappe.get_doc('Crystal Truck Plan', p.trip_id)
        
        # UPDATE: Expose the actual float capacity
        max_tonnage = frappe.db.get_value('Vehicle Type', p.capacity_kg, 'max_tonnage') if p.capacity_kg else 0.0
        
        # Format orders for the UI parser
        orders = [{
            'name': r.sales_order,
            'customer_name': r.customer_name,
            'delivery_region': r.delivery_region
        } for r in doc.orders]

        result.append({
            'truck_number': p.truck_number,
            'driver_name': p.driver_name,
            'vehicle_type': p.capacity_kg, # Send the actual Vehicle Type string reference
            'capacity_kg': max_tonnage, # Fallback to mapped max tonnage for math
            'max_tonnage': max_tonnage,
            'trip_id': p.trip_id,
            'closed_at': p.closed_at,
            'warehouse_status': p.get('warehouse_status', 'Pending'),
            'order_count': len(orders),
            'total_weight': sum(r.total_net_weight for r in doc.orders),
            'total_value': sum(r.grand_total for r in doc.orders),
            'orders': orders
        })
    return result


# ─── SYNCING ASSIGNMENTS (THE ROW-LEVEL LOCK) ────────────────────────────────

@frappe.whitelist()
def set_truck_number(order_name, truck_number):
    """Wraps the optimized batch assigner for a single order."""
    return set_truck_batch_atomic(truck_number, json.dumps([order_name]))


@frappe.whitelist()
def set_truck_batch_atomic(truck_number, order_names_json):
    """
    Provides ultra-fast atomic batch assignment. 
    Fetches the Parent Document ONCE, appends all orders, and saves ONCE.
    """
    order_names = json.loads(order_names_json)
    if not order_names:
        return True

    # Setup the New Plan document if a truck is specified
    new_plan = None
    existing_orders_in_plan = []
    if truck_number:
        new_plan_name = frappe.db.get_value('Crystal Truck Plan', {'truck_number': truck_number, 'docstatus': 0}, 'name')
        if not new_plan_name:
            frappe.throw(f"Active draft plan for Truck {truck_number} not found.")
        new_plan = frappe.get_doc('Crystal Truck Plan', new_plan_name)
        existing_orders_in_plan = [r.sales_order for r in new_plan.orders]

    needs_new_plan_save = False

    for order_name in order_names:
        prev_truck = frappe.db.get_value('Sales Order', order_name, 'custom_truck_number')

        # 1. Flag the Base Sales Order (Fast SQL Write)
        frappe.db.set_value('Sales Order', order_name, {
            'custom_truck_number': truck_number or '',
            'custom_truck_closed': 0,
            'custom_is_pre_fulfillment': 0 if truck_number else frappe.db.get_value('Sales Order', order_name, 'custom_is_pre_fulfillment')
        }, update_modified=False)

        # 2. Extract from Previous Draft Truck (If it was moved or unassigned)
        if prev_truck and prev_truck != truck_number:
            old_plan_name = frappe.db.get_value('Crystal Truck Plan', {'truck_number': prev_truck, 'docstatus': 0}, 'name')
            if old_plan_name:
                old_plan = frappe.get_doc('Crystal Truck Plan', old_plan_name)
                rows_to_remove = [r for r in old_plan.orders if r.sales_order == order_name]
                for r in rows_to_remove:
                    old_plan.remove(r)
                if rows_to_remove:
                    old_plan.warehouse_status = 'Pending'  # NEW: Revert to pending because order was removed
                    old_plan.save(ignore_permissions=True)

        # 3. Inject into New Draft Truck Memory
        if new_plan and order_name not in existing_orders_in_plan:
            so = frappe.db.get_value('Sales Order', order_name, 
                ['customer_name', 'customer', 'custom_delivery_region', 'grand_total', 'total_net_weight'], as_dict=True)
            
            new_plan.append('orders', {
                'sales_order': order_name,
                'customer_name': so.customer_name or so.customer,
                'delivery_region': so.custom_delivery_region,
                'grand_total': so.grand_total,
                'total_net_weight': so.total_net_weight,
                'is_acknowledged_by_warehouse': 0  # Replaces LocalStorage Badging
            })
            new_plan.warehouse_status = 'Pending'  # NEW: Revert to pending because a new order was added
            existing_orders_in_plan.append(order_name)
            needs_new_plan_save = True

    # 4. Save the New Plan ONCE
    if needs_new_plan_save and new_plan:
        new_plan.save(ignore_permissions=True)

    return True


@frappe.whitelist()
def set_pre_fulfillment(order_name, value=1):
    frappe.db.set_value('Sales Order', order_name, 'custom_is_pre_fulfillment', int(value))
    return True


# ─── DISPATCH ENGINE (FREEZING THE STATE) ────────────────────────────────────

def _get_valid_route_coordinates(plan):
    """
    Builds the ordered [lng, lat] coordinate sequence for ORS: factory ->
    each order's customer location -> factory. Orders with null/zero
    coordinates are excluded entirely (never coerced to (0,0)), matching
    the exact valid_stops/unmapped_stops filtering already used client-side
    in _execute_route_mapping and draw_group_route.

    Returns (coordinates, valid_order_count, total_order_count, so_names).
    so_names is parallel to the customer portion of `coordinates` (same
    order, same length) — it's what lets the caller map VROOM's returned
    waypoint_order (customer-array indices) back to actual Sales Order
    names for persisting the visiting sequence onto the plan.

    If fewer than 2 real waypoints exist (factory + at least one customer),
    returns (None, valid_order_count, total_order_count, []) — signalling
    "route not computable" to the caller, which then skips the ORS call
    gracefully.
    """
    company_coords = get_company_coordinates()
    if company_coords.get("status") != "success":
        return None, 0, len(plan.orders), []

    factory_lat = flt(company_coords["lat"])
    factory_lng = flt(company_coords["lng"])

    total_order_count = len(plan.orders)
    valid_order_count = 0
    coordinates = [[factory_lng, factory_lat]]
    so_names = []

    for row in plan.orders:
        # Customer isn't stored directly on Crystal Truck Plan Order — resolve
        # via the Sales Order instead, matching how the rest of this file
        # (get_truck_assignment_orders) already joins through Customer.
        so_customer = frappe.db.get_value("Sales Order", row.sales_order, "customer")
        if not so_customer:
            continue

        cust_lat = frappe.db.get_value("Customer", so_customer, "custom_latitude")
        cust_lng = frappe.db.get_value("Customer", so_customer, "custom_longitude")

        cust_lat = flt(cust_lat)
        cust_lng = flt(cust_lng)

        if not cust_lat or not cust_lng or cust_lat == 0.0 or cust_lng == 0.0:
            continue

        coordinates.append([cust_lng, cust_lat])
        so_names.append(row.sales_order)
        valid_order_count += 1

    if valid_order_count == 0:
        return None, 0, total_order_count, []

    coordinates.append([factory_lng, factory_lat])
    return coordinates, valid_order_count, total_order_count, so_names

def _apply_order_sequence_to_plan(plan, sequence):
    """
    Reorders plan.orders (the in-memory child table list) to match a route-
    optimized visiting sequence (a list of Sales Order names, in visit
    order). Frappe re-numbers each child row's idx from the CURRENT Python
    list order at save time — setting idx directly has no effect, since
    save_children() overwrites it based on list position — so the actual
    fix here is re-sorting the list itself, not the idx field.

    Rows whose sales_order isn't in `sequence` (e.g. excluded from routing
    for lack of GPS) are pushed to the end, preserving their relative order
    among themselves.
    """
    order_position = {so_name: pos for pos, so_name in enumerate(sequence)}
    fallback_base = len(sequence)

    def sort_key(row):
        if row.sales_order in order_position:
            return order_position[row.sales_order]
        return fallback_base + (row.idx or 0)

    plan.orders.sort(key=sort_key)

def _compute_route_and_margin_for_dispatch(plan):
    """
    Server-side authoritative recompute, run silently right before submit —
    mirrors nexus_load_optimizer.create_load_plan's own pattern of always
    recalculating route + cost at the point of finalization, regardless of
    whatever the client last displayed. Never blocks dispatch: a routing
    engine outage or missing GPS data degrades to "unavailable" fields
    rather than preventing the plan from being submitted.
    """
    distance_km = None
    duration_seconds = None
    route_geojson_str = None

    try:
        coordinates, valid_count, total_count, so_names = _get_valid_route_coordinates(plan)

        if coordinates:
            resp = requests.post(
                f"{CRYSTAL_API_BASE_URL}/calculate-route",
                json={"coordinates": coordinates},
                headers={"x-internal-secret": CRYSTAL_API_INTERNAL_SECRET or ""},
                timeout=20
            )
            resp.raise_for_status()
            data = resp.json()

            if "features" in data:
                route_geojson_str = json.dumps(data)
                summary = data["features"][0]["properties"].get("summary", {})
                distance_km = flt(summary.get("distance", 0)) / 1000.0
                duration_seconds = int(flt(summary.get("duration", 0)))

                # 🚨 NEW: Authoritative ordering — regardless of whether the
                # manager clicked "Optimize Route" beforehand, re-derive and
                # apply the real route sequence right before submit, so the
                # manifest (built from plan.orders in child-table order) is
                # always arranged by actual route distance from/to the
                # factory, never by incidental assignment order.
                waypoint_order = data.get("waypoint_order")
                if waypoint_order and so_names:
                    sequence = [so_names[i] for i in waypoint_order if i < len(so_names)]
                    _apply_order_sequence_to_plan(plan, sequence)
    except Exception as e:
        frappe.log_error(f"Dispatch route computation failed for {plan.name}: {e}", "Crystal Truck Plan Dispatch — Routing")

    fuel_litres = None
    fuel_cost = None
    if distance_km is not None and plan.capacity_kg:
        try:
            fuel_result = get_vehicle_routing_economics(
                distance_km=distance_km,
                vehicle_type=plan.capacity_kg
            )
            if fuel_result.get("status") == "success":
                fuel_litres = fuel_result.get("total_litres_required")
                fuel_cost = fuel_result.get("estimated_fuel_cost")
        except Exception as e:
            frappe.log_error(f"Dispatch fuel computation failed for {plan.name}: {e}", "Crystal Truck Plan Dispatch — Fuel")

    margin_result = None
    try:
        # Cross-app import — both apps live on the same bench/site, so a
        # direct in-process Python import is used instead of an HTTP call.
        from nexus_supply_chain.routing.margin_analysis import get_margin_analysis

        sales_order_names = [row.sales_order for row in plan.orders if row.sales_order]
        margin_result = get_margin_analysis(
            sales_orders=sales_order_names,
            distance_km=distance_km,
            vehicle_type=plan.capacity_kg
        )
    except Exception as e:
        frappe.log_error(f"Dispatch margin computation failed for {plan.name}: {e}", "Crystal Truck Plan Dispatch — Margin")

    return {
        "distance_km": distance_km,
        "duration_seconds": duration_seconds,
        "route_geojson": route_geojson_str,
        "fuel_litres": fuel_litres,
        "fuel_cost": fuel_cost,
        "margin": margin_result
    }


@frappe.whitelist()
def dispatch_truck(truck_number):
    """
    Submits the Draft Crystal Truck Plan, permanently locking the truck allocation 
    report. Flags all attached Sales Orders to vanish from the active queue.

    Before submitting, silently and authoritatively recomputes the route
    (ORS), fuel estimate (Vehicle Type economics), and margin analysis
    (COGS/VAT/fuel-narrowed gross), writing the results onto the plan's
    Batch-1 fields — independent of whatever the client last displayed via
    the "Analyse Margins" / "Optimize Route" buttons, and regardless of how
    long ago (or whether) those buttons were clicked.
    """
    plan_name = frappe.db.get_value('Crystal Truck Plan', {'truck_number': truck_number, 'docstatus': 0}, 'name')
    if not plan_name:
        frappe.throw(f"No active Draft plan found for Truck {truck_number}.")

    plan = frappe.get_doc('Crystal Truck Plan', plan_name)

    if not plan.orders:
        frappe.throw(f"Cannot dispatch an empty truck ({truck_number}).")

    # ── Silent authoritative recompute ──────────────────────────────────
    computed = _compute_route_and_margin_for_dispatch(plan)

    plan.approximate_total_distance_km = computed["distance_km"] or 0.0
    plan.approximate_trip_duration = computed["duration_seconds"] or 0
    plan.approximate_fuel_consumption_ltrs = computed["fuel_litres"] or 0.0
    plan.approximate_fuel_cost = computed["fuel_cost"] or 0.0
    plan.route_geojson = computed["route_geojson"] or ""

    margin = computed["margin"] or {}
    plan.total_order_value = margin.get("total_order_value", 0.0)
    plan.total_theoretical_cost = margin.get("total_theoretical_cost", 0.0)
    plan.narrowed_gross_profit = margin.get("narrowed_gross_profit", 0.0)
    plan.narrowed_gross_margin_percentage = margin.get("narrowed_gross_margin_percentage", 0.0)

    threshold = flt(frappe.db.get_single_value("Crystal Fleet Settings", "narrowed_margin_profitability_threshold")) or 33.0
    plan.profitability_status = "Profitable" if plan.narrowed_gross_margin_percentage >= threshold else "Loss"

    # 1. Lock the Report
    plan.warehouse_status = 'Loaded' # Ensure it registers as fully loaded upon final dispatch
    plan.submit()

    # 2. Update Sales Order states
    for row in plan.orders:
        frappe.db.set_value('Sales Order', row.sales_order, {
            'custom_truck_closed': 1,
            'custom_is_pre_fulfillment': 0
        })

    return True


@frappe.whitelist()
def get_fleet_settings():
    """
    Returns the current profitability threshold from Crystal Fleet Settings,
    for the Truck Assignment page to fetch ONCE at page load and cache
    client-side (rather than re-fetching per card render). A dedicated
    endpoint is used here instead of a raw frappe.client.get_single_value
    call so the frontend doesn't need System Manager-level read access to
    the Settings doctype directly, and so the response shape can be
    extended later without a client-side contract change.
    """
    threshold = frappe.db.get_single_value(
        "Crystal Fleet Settings",
        "narrowed_margin_profitability_threshold"
    )
    return {
        "narrowed_margin_profitability_threshold": flt(threshold) if threshold is not None else 33.0
    }

@frappe.whitelist()
def reorder_truck_plan_orders(truck_number, sales_order_sequence_json):
    """
    Persists a route-optimized visiting sequence onto a Draft Crystal Truck
    Plan's orders child table, called from the Truck Assignment page right
    after "Optimize Route" resolves a VROOM waypoint_order for a real,
    already-assigned truck. This is a convenience/consistency write — the
    authoritative version of this same reordering also runs at Dispatch
    time (_compute_route_and_margin_for_dispatch), so a manager never HAS
    to click Optimize Route first for the manifest to come out ordered
    correctly; this just keeps the draft plan's own child table visually
    consistent with whatever the manager last saw on the map in the
    meantime.

    Silently a no-op (returns "skipped") if the truck has no active draft
    plan — e.g. when called from the Awaiting Orders bulk button before
    any orders have actually been assigned to that truck yet.
    """
    sequence = frappe.parse_json(sales_order_sequence_json) if isinstance(sales_order_sequence_json, str) else sales_order_sequence_json
    if not sequence:
        return {"status": "skipped", "message": "No sequence provided."}

    plan_name = frappe.db.get_value('Crystal Truck Plan', {'truck_number': truck_number, 'docstatus': 0}, 'name')
    if not plan_name:
        return {"status": "skipped", "message": f"No active draft plan for truck {truck_number}."}

    plan = frappe.get_doc('Crystal Truck Plan', plan_name)
    _apply_order_sequence_to_plan(plan, sequence)
    plan.save(ignore_permissions=True)
    frappe.db.commit()

    return {"status": "success", "updated": len(plan.orders)}

@frappe.whitelist()
def reopen_dispatched_truck(truck_number):
    """Cancels a submitted DocType and clones it back into a Draft."""
    plan_name = frappe.db.get_value('Crystal Truck Plan', {'truck_number': truck_number, 'docstatus': 1}, 'name', order_by='modified DESC')
    if not plan_name:
        frappe.throw(f"No dispatched plan found for {truck_number}")

    plan = frappe.get_doc('Crystal Truck Plan', plan_name)
    plan.cancel()

    # Clone to a new active draft
    new_plan = frappe.copy_doc(plan)
    new_plan.docstatus = 0
    new_plan.warehouse_status = 'Pending' # NEW: Restores the segregation lock
    
    # Reset the warehouse acknowledgements
    for row in new_plan.orders:
        row.is_acknowledged_by_warehouse = 0
        
    new_plan.insert(ignore_permissions=True)

    # Free the Sales Orders
    for row in new_plan.orders:
        frappe.db.set_value('Sales Order', row.sales_order, 'custom_truck_closed', 0)

    return True


@frappe.whitelist()
def check_and_auto_close_trucks():
    """
    Background job: Checks all Active Draft trucks. If all SOs are fully 
    delivered and billed, it securely pushes the dispatch function.
    """
    active_plans = frappe.get_all('Crystal Truck Plan', filters={'docstatus': 0})
    auto_closed = []

    for plan_info in active_plans:
        plan = frappe.get_doc('Crystal Truck Plan', plan_info.name)
        
        if not plan.orders:
            continue

        all_complete = True
        for row in plan.orders:
            so = frappe.db.get_value('Sales Order', row.sales_order, ['per_delivered', 'per_billed'], as_dict=True)
            if not so or float(so.per_delivered or 0) < 100 or float(so.per_billed or 0) < 100:
                all_complete = False
                break

        if all_complete:
            dispatch_truck(plan.truck_number)
            auto_closed.append(plan.truck_number)

    return auto_closed


# ─── ROUTING & ECONOMICS ENGINE (NEXUS INTEGRATION) ──────────────────────────

@frappe.whitelist()
def get_company_coordinates(company=None):
    """
    Fetches the factory baseline coordinates for the route sequence starting and ending points.
    Defaults to the user's assigned Company if none is explicitly provided.
    """
    if not company:
        company = frappe.defaults.get_user_default("Company")
        
    if not company:
        frappe.throw(_("No default Company found. Please set a Company in Global Defaults."))

    lat = frappe.db.get_value("Company", company, "custom_latitude")
    lng = frappe.db.get_value("Company", company, "custom_longitude")

    if not lat or not lng:
        return {"status": "error", "message": f"GPS coordinates missing for Company '{company}'."}

    return {
        "status": "success",
        "lat": flt(lat), 
        "lng": flt(lng)
    }

@frappe.whitelist()
def get_vehicle_routing_economics(distance_km, vehicle_type, truck_number=None):
    """
    Calculates exact theoretical fuel cost given a distance input, 
    gracefully resolving actual Vehicle Types and fetching standard consumption parameters.
    Separates vehicle_type and truck_number to prevent missing column SQL crashes.
    """
    try:
        distance_km = flt(distance_km)
    except (ValueError, TypeError):
        return {"status": "error", "message": "Distance must be a valid numerical value."}

    # 1. Intelligently resolve the vehicle type from the active draft routing doctype if missing
    if not vehicle_type and truck_number:
        vehicle_type = frappe.db.get_value('Crystal Truck Plan', {'truck_number': truck_number, 'docstatus': 0}, 'capacity_kg')
    
    # 2. Fallback gracefully: Check standard Vehicle master data if it wasn't an active draft route.
    # Safely check if the 'vehicle_type' column actually exists to prevent fatal OperationalErrors.
    if not vehicle_type and truck_number:
        if frappe.db.has_column("Vehicle", "vehicle_type"):
            try:
                vehicle = frappe.db.get_value("Vehicle", {"license_plate": truck_number}, "vehicle_type")
                if not vehicle:
                    vehicle = frappe.db.get_value("Vehicle", truck_number, "vehicle_type")
                vehicle_type = vehicle
            except Exception:
                pass

    if not vehicle_type:
        return {"status": "error", "message": f"Could not determine Vehicle Type for Route/Truck: {truck_number or 'Unknown'}"}
        
    # Fetch consumption parameters strictly from the standard Vehicle Type doctype fields
    vt_data = frappe.db.get_value('Vehicle Type', vehicle_type, 
        ["name", "max_tonnage", "fuel_type", "litre_cost", "consumption_km_per_ltr"], as_dict=True)
        
    if not vt_data:
        return {"status": "error", "message": f"Vehicle Type '{vehicle_type}' not found in the system."}

    consumption = flt(vt_data.get("consumption_km_per_ltr"))
    litre_cost = flt(vt_data.get("litre_cost"))
    
    # Safety checks to prevent ZeroDivisionError and gracefully handle missing setup
    if consumption <= 0:
        return {"status": "error", "message": f"Fuel consumption (Km/L) is not configured correctly for Vehicle Type '{vehicle_type}'."}
        
    if litre_cost <= 0:
        return {"status": "error", "message": f"Litre Cost for Vehicle Type '{vehicle_type}' is zero or not set."}

    # Perform the exact economic calculation
    total_litres = distance_km / consumption
    total_cost = total_litres * litre_cost
    
    currency = frappe.defaults.get_global_default("default_currency") or "KES"
    
    return {
        "status": "success",
        "estimated_fuel_cost": round(total_cost, 2),
        "total_litres_required": round(total_litres, 2),
        "distance_km": distance_km,
        "currency": currency,
        "economics_used": vt_data
    }
