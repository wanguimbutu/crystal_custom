import frappe
from frappe.utils import flt


@frappe.whitelist()
def get_production_data(from_date=None, to_date=None):
    """
    Returns everything the production page needs in one call:
    - Manufacture Material Requests (not cancelled, not stopped)
    - Work Orders linked to those MRs
    - BOM-level raw material requirements + current bin stock for each WO
    - Truck assignments per item_code (from active SOs)
    """
    date_conds = ""
    date_params = {}
    if from_date:
        date_conds += " AND mr.transaction_date >= %(from_date)s"
        date_params['from_date'] = from_date
    if to_date:
        date_conds += " AND mr.transaction_date <= %(to_date)s"
        date_params['to_date'] = to_date

    # ── Material Requests (Manufacture) ───────────────────────────────────────
    mrs = frappe.db.sql(f"""
        SELECT
            mr.name,
            mr.transaction_date,
            mr.schedule_date,
            mr.status
        FROM `tabMaterial Request` mr
        WHERE mr.material_request_type = 'Manufacture'
          AND mr.docstatus != 2
          AND mr.status NOT IN ('Stopped', 'Cancelled')
          {date_conds}
        ORDER BY mr.transaction_date DESC
        LIMIT 200
    """, date_params, as_dict=1)

    mr_names = [r.name for r in mrs]

    mr_items = []
    if mr_names:
        mr_items = frappe.db.sql("""
            SELECT
                mri.name,
                mri.parent       AS mr_name,
                mri.item_code,
                mri.item_name,
                mri.qty,
                mri.uom,
                mri.warehouse
            FROM `tabMaterial Request Item` mri
            WHERE mri.parent IN %(names)s
            ORDER BY mri.parent, mri.idx
        """, {'names': mr_names}, as_dict=1)

    # ── Truck lookup per item_code ─────────────────────────────────────────────
    item_codes = list({i.item_code for i in mr_items})
    truck_map = {}
    if item_codes:
        truck_rows = frappe.db.sql("""
            SELECT
                soi.item_code,
                GROUP_CONCAT(DISTINCT so.custom_truck_number
                             ORDER BY so.custom_truck_number SEPARATOR ', ') AS trucks
            FROM `tabSales Order Item` soi
            JOIN `tabSales Order` so ON so.name = soi.parent
            WHERE so.docstatus = 1
              AND so.status NOT IN ('Completed', 'Closed', 'Cancelled')
              AND IFNULL(so.custom_truck_number, '') != ''
              AND soi.item_code IN %(codes)s
            GROUP BY soi.item_code
        """, {'codes': item_codes}, as_dict=1)
        truck_map = {r.item_code: r.trucks for r in truck_rows}

    for i in mr_items:
        i['trucks'] = truck_map.get(i.item_code, '') or ''

    # ── Work Orders linked to those MRs ───────────────────────────────────────
    work_orders = []
    if mr_names:
        work_orders = frappe.db.sql("""
            SELECT
                wo.name,
                wo.production_item,
                wo.item_name,
                wo.qty,
                wo.produced_qty,
                wo.status,
                wo.planned_start_date,
                wo.planned_end_date,
                wo.actual_start_date,
                wo.bom_no,
                wo.material_request   AS mr_name,
                wo.wip_warehouse,
                wo.fg_warehouse,
                0 AS is_paint_order
            FROM `tabWork Order` wo
            WHERE wo.material_request IN %(names)s
              AND wo.docstatus != 2
            ORDER BY wo.creation DESC
        """, {'names': mr_names}, as_dict=1)

    # ── BOM raw material requirements per Work Order ──────────────────────────
    bom_items = []
    if work_orders:
        boms = list({w.bom_no for w in work_orders if w.bom_no})
        if boms:
            bom_items = frappe.db.sql("""
                SELECT
                    bi.parent  AS bom_no,
                    bi.item_code,
                    bi.item_name,
                    bi.qty     AS qty_per_unit,
                    bi.uom,
                    bi.source_warehouse
                FROM `tabBOM Item` bi
                WHERE bi.parent IN %(boms)s
                  AND bi.docstatus = 1
            """, {'boms': boms}, as_dict=1)

    bom_map = {}
    for bi in bom_items:
        bom_map.setdefault(bi.bom_no, []).append(bi)

    all_item_codes = list({bi.item_code for bi in bom_items})
    stock_map = {}
    if all_item_codes:
        bins = frappe.db.sql("""
            SELECT item_code, SUM(actual_qty) AS actual_qty
            FROM `tabBin`
            WHERE item_code IN %(codes)s
            GROUP BY item_code
        """, {'codes': all_item_codes}, as_dict=1)
        stock_map = {b.item_code: flt(b.actual_qty) for b in bins}

    wo_data = []
    for wo in work_orders:
        scale = flt(wo.qty)
        bom_reqs = []
        for bi in bom_map.get(wo.bom_no, []):
            needed   = flt(bi.qty_per_unit) * scale
            in_stock = stock_map.get(bi.item_code, 0)
            bom_reqs.append({
                'item_code':  bi.item_code,
                'item_name':  bi.item_name,
                'needed':     needed,
                'in_stock':   in_stock,
                'shortfall':  max(0, needed - in_stock),
                'uom':        bi.uom,
            })
        pct = round((flt(wo.produced_qty) / scale * 100), 1) if scale else 0
        wo_data.append({
            **{k: v for k, v in wo.items()},
            'pct_complete': pct,
            'can_start':    all(r['shortfall'] == 0 for r in bom_reqs),
            'bom_items':    bom_reqs,
        })

    # ── Manufacturing Worksheets: In Process + Completed by planned date ─────────
    ws_date_conds = ""
    if from_date:
        ws_date_conds += " AND wo.planned_start_date >= %(from_date)s"
    if to_date:
        ws_date_conds += " AND wo.planned_start_date <= %(to_date)s"

    worksheets = frappe.db.sql(f"""
        SELECT
            wo.name,
            wo.production_item,
            wo.item_name,
            wo.qty,
            wo.produced_qty,
            wo.status,
            wo.planned_start_date,
            wo.actual_start_date,
            wo.actual_end_date,
            wo.material_request  AS mr_name
        FROM `tabWork Order` wo
        WHERE wo.docstatus != 2
          AND wo.status IN ('In Process', 'Completed')
          {ws_date_conds}
        ORDER BY
            FIELD(wo.status, 'In Process', 'Completed'),
            wo.planned_start_date DESC
        LIMIT 500
    """, date_params, as_dict=1)

    # ── Sales Orders with paint / colour notes ────────────────────────────────
    paint_orders = frappe.db.sql("""
        SELECT
            name,
            customer_name,
            transaction_date,
            custom_delivery_region,
            custom_truck_number,
            custom_paint_notes,
            workflow_state
        FROM `tabSales Order`
        WHERE docstatus != 2
          AND status NOT IN ('Completed', 'Closed')
          AND IFNULL(custom_paint_notes, '') != ''
        ORDER BY transaction_date DESC
        LIMIT 200
    """, as_dict=1)

    return {
        'mrs':          [dict(r) for r in mrs],
        'mr_items':     [dict(r) for r in mr_items],
        'work_orders':   wo_data,
        'worksheets':   [dict(r) for r in worksheets],
        'paint_orders': [dict(r) for r in paint_orders],
    }


@frappe.whitelist()
def close_request(mr_name):
    """Stop a Material Request so it moves out of the active production list."""
    frappe.db.set_value('Material Request', mr_name, 'status', 'Stopped')
    frappe.db.commit()
    return 'ok'


@frappe.whitelist()
def create_work_order(mr_name, item_code, qty, bom_no=None):
    """Create a Work Order from a Material Request item."""
    if not bom_no:
        bom_no = frappe.db.get_value('BOM', {'item': item_code, 'is_active': 1, 'is_default': 1}, 'name')
    if not bom_no:
        bom_no = frappe.db.get_value('BOM', {'item': item_code, 'is_active': 1}, 'name',
                                     order_by='creation desc')
    if not bom_no:
        frappe.throw(f'No active BOM found for item {item_code}')

    bom = frappe.get_doc('BOM', bom_no)
    company = frappe.defaults.get_user_default('Company') or frappe.db.get_single_value('Global Defaults', 'default_company')

    wo = frappe.new_doc('Work Order')
    wo.production_item   = item_code
    wo.bom_no            = bom_no
    wo.qty               = flt(qty)
    wo.company           = company
    wo.material_request  = mr_name
    wo.planned_start_date = frappe.utils.today()
    wo.fg_warehouse      = (frappe.db.get_value('Item Default',
                                {'parent': item_code, 'company': company}, 'default_warehouse')
                            or bom.fg_warehouse or '')
    wo.wip_warehouse     = bom.with_operations and bom.fg_warehouse or ''
    wo.insert(ignore_permissions=True)
    return wo.name


@frappe.whitelist()
def submit_work_order(wo_name):
    wo = frappe.get_doc('Work Order', wo_name)
    wo.submit()
    return wo.name


@frappe.whitelist()
def get_bom_list(item_code):
    """Return all active BOMs for an item so the user can pick one."""
    boms = frappe.db.get_all(
        'BOM',
        filters={'item': item_code, 'is_active': 1, 'docstatus': 1},
        fields=['name', 'item_name', 'is_default'],
        order_by='is_default desc, creation desc',
    )
    return boms
