-- Create campaign_folders table
CREATE TABLE campaign_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(name, client_id)
);

-- Add folder_id to campaigns table
ALTER TABLE campaigns ADD COLUMN folder_id UUID REFERENCES campaign_folders(id) ON DELETE SET NULL;

-- Create indexes for performance
CREATE INDEX idx_campaign_folders_client_id ON campaign_folders(client_id);
CREATE INDEX idx_campaigns_folder_id ON campaigns(folder_id);

-- Enable RLS
ALTER TABLE campaign_folders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations on campaign_folders" ON campaign_folders FOR ALL USING (true);

-- Add updated_at trigger
CREATE TRIGGER update_campaign_folders_updated_at BEFORE UPDATE ON campaign_folders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
