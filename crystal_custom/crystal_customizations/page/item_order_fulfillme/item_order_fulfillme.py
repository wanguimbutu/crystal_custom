import frappe
from frappe import _

FINANCE_APPROVED_STATES = ('Pending Customer Order Reconfirmation', 'Order Confirmed')

@frappe.whitelist()
def get_sales_order_fulfillment(from_date=None, to_date=None):
    """
    Analyze finance-approved sales orders against finished goods inventory.
    Returns items with required qty, available qty, and shortage.
    """
    conditions = [
        "so.workflow_state IN %(states)s",
        "so.status NOT IN ('Completed', 'Closed')",
        "soi.qty > soi.delivered_qty",
    ]
    params = {'states': FINANCE_APPROVED_STATES}

    if from_date:
        conditions.append("so.transaction_date >= %(from_date)s")
        params['from_date'] = from_date
    if to_date:
        conditions.append("so.transaction_date <= %(to_date)s")
        params['to_date'] = to_date

    where_clause = " AND ".join(conditions)

    sales_order_items = frappe.db.sql(f"""
        SELECT
            soi.item_code,
            soi.item_name,
            SUM(soi.qty - soi.delivered_qty) as required_qty
        FROM `tabSales Order Item` soi
        INNER JOIN `tabSales Order` so ON soi.parent = so.name
        WHERE {where_clause}
        GROUP BY soi.item_code, soi.item_name
    """, params, as_dict=1)
    
    result = []
    
    for item in sales_order_items:
        # Get available quantity from finished goods warehouses
        # Adjust warehouse condition based on your setup
        available_qty = frappe.db.sql("""
            SELECT IFNULL(SUM(actual_qty), 0) as available_qty
            FROM `tabBin`
            WHERE item_code = %s
            AND warehouse IN (
                SELECT name FROM `tabWarehouse` 
                WHERE warehouse_type = 'Finished Goods - CAL' 
                OR is_group = 0
            )
        """, (item.item_code,), as_dict=1)[0].available_qty
        
        shortage = item.required_qty - available_qty
        
        result.append({
            'item_code': item.item_code,
            'item_name': item.item_name,
            'required_qty': item.required_qty,
            'available_qty': available_qty,
            'shortage': max(shortage, 0)
        })
    
    # Sort by shortage descending (items with highest shortage first)
    result = sorted(result, key=lambda x: x['shortage'], reverse=True)
    
    return result


@frappe.whitelist()
def create_material_request_from_shortage(from_date=None, to_date=None):
    """
    Create a draft Material Request for items with shortages
    Type: Manufacture
    """

    fulfillment_data = get_sales_order_fulfillment(from_date=from_date, to_date=to_date)
    
    # Filter only items with shortages
    shortage_items = [item for item in fulfillment_data if item['shortage'] > 0]
    
    if not shortage_items:
        frappe.throw(_("No items with shortages found"))
    
    # Create Material Request
    mr = frappe.new_doc('Material Request')
    mr.material_request_type = 'Manufacture'
    mr.transaction_date = frappe.utils.today()
    mr.schedule_date = frappe.utils.add_days(frappe.utils.today(), 7)  # Default 7 days from now
    
    # Add items to Material Request
    for item in shortage_items:
        mr.append('items', {
            'item_code': item['item_code'],
            'item_name': item['item_name'],
            'qty': item['shortage'],
            'schedule_date': mr.schedule_date,
            'warehouse': get_default_warehouse_for_manufacture(item['item_code'])
        })
    
    mr.insert(ignore_permissions=False)
    
    return mr.name


def get_default_warehouse_for_manufacture(item_code):
    # Item Default child table holds the per-company default warehouse
    warehouse = frappe.db.get_value('Item Default', {'parent': item_code}, 'default_warehouse')
    if warehouse:
        return warehouse

    # Fall back to any non-group, enabled warehouse
    return frappe.db.get_value('Warehouse', {'is_group': 0, 'disabled': 0}, 'name')
    
    # Option 3: Return None and let user select
    return None