package glance

import (
	"html/template"
)

var countersWidgetTemplate = mustParseTemplate("counters.html", "widget-base.html")

type countersWidget struct {
	widgetBase `yaml:",inline"`
	cachedHTML template.HTML `yaml:"-"`
	Labels     []string      `yaml:"labels"`
}

func (widget *countersWidget) initialize() error {
	widget.withTitle("Counters").withError(nil)

	widget.cachedHTML = widget.renderTemplate(widget, countersWidgetTemplate)
	return nil
}

func (widget *countersWidget) Render() template.HTML {
	return widget.cachedHTML
}
