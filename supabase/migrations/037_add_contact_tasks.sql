-- Migration 037: Add contact_tasks table for CRM task management
-- Supports the ContactTask type defined in src/types/index.ts

CREATE TABLE IF NOT EXISTS contact_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  due_date TIMESTAMP WITH TIME ZONE,
  is_completed BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_by TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_contact_tasks_contact_id ON contact_tasks(contact_id);
CREATE INDEX idx_contact_tasks_client_id ON contact_tasks(client_id);
CREATE INDEX idx_contact_tasks_due_date ON contact_tasks(due_date) WHERE NOT is_completed;

-- RLS using can_access_client() from migration 034
ALTER TABLE contact_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can select contact_tasks" ON contact_tasks
  FOR SELECT USING (can_access_client(client_id));
CREATE POLICY "Admins can insert contact_tasks" ON contact_tasks
  FOR INSERT WITH CHECK (can_access_client(client_id));
CREATE POLICY "Admins can update contact_tasks" ON contact_tasks
  FOR UPDATE USING (can_access_client(client_id));
CREATE POLICY "Admins can delete contact_tasks" ON contact_tasks
  FOR DELETE USING (can_access_client(client_id));
