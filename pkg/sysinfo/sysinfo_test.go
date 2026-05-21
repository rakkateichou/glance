package sysinfo

import (
	"testing"
)

func TestFilter(t *testing.T) {
	// Helper to create pointer to bool
	boolPtr := func(b bool) *bool {
		return &b
	}

	t.Run("HideMountpointsByDefault with specific overrides", func(t *testing.T) {
		req := &SystemInfoRequest{
			HideMountpointsByDefault: true,
			Mountpoints: map[string]MointpointRequest{
				"/storage": {
					Name: "Root",
					Hide: boolPtr(false),
				},
				"/ignored": {
					Name: "Ignored But Hidden",
					Hide: boolPtr(true),
				},
			},
		}

		info := &SystemInfo{
			Mountpoints: []MountpointInfo{
				{Path: "/storage", Name: "Disk 1", UsedPercent: 45},
				{Path: "/boot", Name: "Boot Partition", UsedPercent: 20},
				{Path: "/data", Name: "Data Partition", UsedPercent: 80},
			},
		}

		req.Filter(info)

		if len(info.Mountpoints) != 1 {
			t.Errorf("Expected 1 mountpoint, got %d", len(info.Mountpoints))
		}

		if info.Mountpoints[0].Path != "/storage" {
			t.Errorf("Expected mountpoint /storage, got %s", info.Mountpoints[0].Path)
		}

		if info.Mountpoints[0].Name != "Root" {
			t.Errorf("Expected mountpoint name to be updated to 'Root', got %s", info.Mountpoints[0].Name)
		}
	})

	t.Run("ShowMountpointsByDefault with specific hides", func(t *testing.T) {
		req := &SystemInfoRequest{
			HideMountpointsByDefault: false,
			Mountpoints: map[string]MointpointRequest{
				"/boot": {
					Hide: boolPtr(true),
				},
				"/data": {
					Name: "Custom Data",
				},
			},
		}

		info := &SystemInfo{
			Mountpoints: []MountpointInfo{
				{Path: "/storage", Name: "Disk 1", UsedPercent: 45},
				{Path: "/boot", Name: "Boot Partition", UsedPercent: 20},
				{Path: "/data", Name: "Data Partition", UsedPercent: 80},
			},
		}

		req.Filter(info)

		if len(info.Mountpoints) != 2 {
			t.Errorf("Expected 2 mountpoints, got %d", len(info.Mountpoints))
		}

		// Check sorting: /data has 80%, /storage has 45%. So /data should be first.
		if info.Mountpoints[0].Path != "/data" {
			t.Errorf("Expected first mountpoint to be /data (sorted by UsedPercent), got %s", info.Mountpoints[0].Path)
		}

		if info.Mountpoints[0].Name != "Custom Data" {
			t.Errorf("Expected first mountpoint name to be 'Custom Data', got %s", info.Mountpoints[0].Name)
		}

		if info.Mountpoints[1].Path != "/storage" {
			t.Errorf("Expected second mountpoint to be /storage, got %s", info.Mountpoints[1].Path)
		}
	})
}
