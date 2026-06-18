import frappe
from frappe.model.document import Document


class CrystalTruckPlan(Document):
    def before_save(self):
        self.order_count = len(self.orders)
        self.total_weight = sum(row.total_net_weight or 0 for row in self.orders)
        self.total_value = sum(row.grand_total or 0 for row in self.orders)
        regions = sorted({row.delivery_region for row in self.orders if row.delivery_region})
        self.delivery_regions = ', '.join(regions)
