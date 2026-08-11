import frappe

def on_submit(doc, method):
    """Fires immediately after a Delivery Note is successfully submitted."""
    sync_truck_plan_delivered_qty(doc, multiplier=1)

def on_cancel(doc, method):
    """Fires immediately after a Delivery Note is cancelled, reversing the trace."""
    sync_truck_plan_delivered_qty(doc, multiplier=-1)


def sync_truck_plan_delivered_qty(doc, multiplier):
    """
    The Data Bridge: Traces standard Delivery Note items back to their Sales Order.
    Finds the most recently active/dispatched Crystal Truck Plan holding that SO.
    Safely updates the delivered_qty in the Crystal Truck Plan Allocation child table.
    """
    
    # 1. Aggregate quantities by Sales Order and Item Code
    # This prevents redundant DB calls if a D-Note splits the same item across multiple rows
    so_item_qtys = {}
    for item in doc.items:
        if not item.against_sales_order:
            continue
            
        key = (item.against_sales_order, item.item_code)
        if key not in so_item_qtys:
            so_item_qtys[key] = {
                'qty': 0.0,
                'item_name': item.item_name
            }
        # Using item.qty ensures we respect the exact transactional volume
        so_item_qtys[key]['qty'] += float(item.qty)

    # 2. Trace back to the Truck Plan and inject the data
    for (sales_order, item_code), data in so_item_qtys.items():
        qty = data['qty']
        
        # Find the most recently modified Truck Plan containing this Sales Order.
        # Sorting by modified DESC naturally handles split-orders spanning multiple trucks.
        plan_data = frappe.db.sql("""
            SELECT ctp.name, ctp.docstatus
            FROM `tabCrystal Truck Plan` ctp
            INNER JOIN `tabCrystal Truck Plan Order` ctpo ON ctpo.parent = ctp.name
            WHERE ctp.docstatus IN (0, 1) AND ctpo.sales_order = %s
            ORDER BY ctp.modified DESC
            LIMIT 1
        """, (sales_order,), as_dict=True)

        if not plan_data:
            continue

        plan_name = plan_data[0].name
        
        # 3. Find the specific allocation child row for this item
        alloc_row = frappe.db.get_value(
            'Crystal Truck Plan Allocation', 
            {'parent': plan_name, 'item_code': item_code}, 
            ['name', 'delivered_qty'], 
            as_dict=True
        )

        if alloc_row:
            current_qty = float(alloc_row.delivered_qty or 0.0)
            new_qty = max(0.0, current_qty + (qty * multiplier))
            
            # THE MAGIC: Because delivered_qty has "Allow on Submit = 1", 
            # set_value perfectly overrides the document lock without raw SQL.
            frappe.db.set_value(
                'Crystal Truck Plan Allocation', 
                alloc_row.name, 
                'delivered_qty', 
                new_qty, 
                update_modified=False
            )
        else:
            # 4. GUARDRAIL: If the row doesn't exist (e.g., warehouse skipped planning phase)
            # We explicitly create the child row so the UI has data to render.
            if multiplier == 1:
                new_alloc = frappe.new_doc('Crystal Truck Plan Allocation')
                new_alloc.parent = plan_name
                new_alloc.parenttype = 'Crystal Truck Plan'
                new_alloc.parentfield = 'allocations'
                new_alloc.item_code = item_code
                new_alloc.item_name = data['item_name']
                new_alloc.required_qty = 0.0  # Failsafe if not mapped
                new_alloc.allocated_qty = 0.0 # They didn't plan it
                new_alloc.delivered_qty = qty # But accounting delivered it
                
                # Bypass validation locks to allow safe background injection
                new_alloc.flags.ignore_links = True
                new_alloc.flags.ignore_validate = True
                new_alloc.insert(ignore_permissions=True)