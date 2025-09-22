# Test

```js
import {_dataLevel, generateGraphData, createNodeIndex, groupByLevel,CSVToJSON } from "./components/transform_data.js";
//import {renderChart } from "./components/chart.js";
import {renderChart,renderInteractiveChart } from "./components/chart_svgjs.js";


const hotelData = FileAttachment("data/aa.csv").csv({typed: true});
const hotelData2 = FileAttachment("data/aa.csv").text();
```


```js
display(hotelData2);

```

```js
const pagesSource = view(Inputs.textarea({
  rows: 6,
  width: 420,
  label: `<b>Pages`,
  value: hotelData2
}));
```

```js
display(pagesSource);

```

 <div id="svgjs" class="observablehq" style="overflow: scroll;"></div>

```js

const csvObj = CSVToJSON(pagesSource);
const data = groupByLevel(createNodeIndex(csvObj));
const chart = renderChart(data);

```

```js
display(chart);
```
