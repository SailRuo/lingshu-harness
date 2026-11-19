<template>
  <div ref="chartContainer" class="chart" />
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts';

interface Props {
  data: Array<Record<string, any>>;
  metrics: string[];
}

const props = defineProps<Props>();
const chartContainer = ref<HTMLElement | null>(null);
let chartInstance: any = null;

function renderChart() {
  if (!chartInstance) return;
  const dates = props.data.map(d => d.date);
  
  // Use forest green theme colors
  const colorPalette = ['#3D8C41', '#4E8F59', '#737373'];
  
  const series = props.metrics.map((metric, index) => ({
    name: metric === 'prompt' ? '输入 (Prompt)' : (metric === 'completion' ? '输出 (Completion)' : '总计 (Total)'),
    type: 'line',
    smooth: true,
    data: props.data.map(d => d[metric]),
    lineStyle: { width: 3 },
    itemStyle: { color: colorPalette[index] || '#3D8C41' },
    areaStyle: index === 2 ? {
      color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: 'rgba(61, 140, 65, 0.3)' },
        { offset: 1, color: 'rgba(61, 140, 65, 0)' }
      ])
    } : undefined,
  }));

  chartInstance.setOption({
    tooltip: { 
      trigger: 'axis',
      backgroundColor: '#2A2A2A',
      borderColor: '#404040',
      textStyle: { color: '#E5E5E5' }
    },
    legend: { 
      data: series.map(s => s.name),
      textStyle: { color: '#A6A6A6' },
      bottom: 0
    },
    xAxis: { 
      type: 'category', 
      data: dates, 
      axisLine: { lineStyle: { color: '#404040' } },
      axisLabel: { color: '#737373' }
    },
    yAxis: { 
      type: 'value', 
      axisLine: { show: false },
      splitLine: { lineStyle: { color: '#2A2A2A' } },
      axisLabel: { color: '#737373' }
    },
    series,
    grid: { left: '30px', right: '20px', bottom: '40px', top: '20px', containLabel: true },
    backgroundColor: 'transparent',
  });
}

onMounted(() => {
  if (chartContainer.value) {
    chartInstance = echarts.init(chartContainer.value);
    renderChart();
    window.addEventListener('resize', () => chartInstance.resize());
  }
});

watch(() => props.data, renderChart, { deep: true });
</script>

<style scoped>
.chart { width: 100%; height: 300px; }
</style>
