-- Create template_folders table for organizing email templates
-- Single level folders only (no nesting) - each folder belongs to a client

CREATE TABLE template_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(name, client_id)
);

-- Add folder_id to templates table (nullable for unfiled templates)
ALTER TABLE templates ADD COLUMN folder_id UUID REFERENCES template_folders(id) ON DELETE SET NULL;

-- Index for fast folder lookups by client
CREATE INDEX idx_template_folders_client_id ON template_folders(client_id);

-- Index for fast template lookups by folder
CREATE INDEX idx_templates_folder_id ON templates(folder_id);

-- Enable RLS
ALTER TABLE template_folders ENABLE ROW LEVEL SECURITY;

-- Allow all operations (same pattern as other tables)
CREATE POLICY "Allow all operations on template_folders" ON template_folders FOR ALL USING (true);

-- Trigger for updated_at
CREATE TRIGGER update_template_folders_updated_at BEFORE UPDATE ON template_folders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
