<template>
  <div
    :class="`wechat-emoji-picker ${className}`"
    :style="outerStyle"
  >
    <div class="emoji-scroll" :style="scrollStyle">
      <div class="emoji-grid" :style="gridStyle">
        <button
          v-for="emoji in wechatEmojis"
          :key="emoji.code"
          class="emoji-item"
          @mouseenter="handleMouseEnter"
          @mouseleave="handleMouseLeave"
          @click="onClickEmoji(emoji)"
          :title="emoji.name"
        >
          <img
            v-if="getEmojiImageUrl(emoji.code)"
            :src="getEmojiImageUrl(emoji.code)!"
            :alt="emoji.code"
            class="emoji twemoji picker-emoji"
            :style="emojiImgStyle"
            draggable="false"
          />
          <span v-else class="emoji-fallback">{{ emoji.name }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { wechatEmojis } from './data'
import { getEmojiImageUrl } from './render'

export interface EmojiPickerProps {
  emojiSize?: number
  className?: string
  style?: Record<string, any>
}

const PANEL_WIDTH = 320
const CELL_SIZE = 32
const GRID_GAP = 4
const GRID_PADDING = 12
const VISIBLE_ROWS = 7

const props = withDefaults(defineProps<EmojiPickerProps>(), {
  emojiSize: 20,
  className: '',
  style: () => ({}),
})

const emit = defineEmits<{
  emojiClick: [emoji: { name: string; code: string }]
}>()

const gridViewportHeight =
  VISIBLE_ROWS * CELL_SIZE + (VISIBLE_ROWS - 1) * GRID_GAP

const gridStyle = computed(() => ({
  gridTemplateColumns: 'repeat(9, 1fr)',
  gridAutoRows: `${CELL_SIZE}px`,
  gap: `${GRID_GAP}px`,
}))

const scrollStyle = computed(() => ({
  height: `${gridViewportHeight + GRID_PADDING * 2}px`,
  padding: `${GRID_PADDING}px`,
}))

const outerStyle = computed(() => ({
  width: `${PANEL_WIDTH}px`,
  ...props.style,
}))

const emojiImgStyle = computed(() => ({
  width: `${props.emojiSize}px`,
  height: `${props.emojiSize}px`,
}))

const onClickEmoji = (emoji: { name: string; code: string }) => {
  emit('emojiClick', emoji)
}

const handleMouseEnter = (e: Event) => {
  const target = e.currentTarget as HTMLElement
  target.style.backgroundColor = 'var(--color-fill-3, #f2f3f5)'
}

const handleMouseLeave = (e: Event) => {
  const target = e.currentTarget as HTMLElement
  target.style.backgroundColor = 'transparent'
}
</script>

<style scoped>
.wechat-emoji-picker {
  position: relative;
  background-color: var(--color-bg-5, #ffffff);
  border: 1px solid var(--color-border-2, #e5e6eb);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}

.emoji-scroll {
  overflow-y: auto;
  overflow-x: visible;
  box-sizing: border-box;
  scrollbar-width: thin;
  scrollbar-color: var(--color-fill-4, #e5e6eb) transparent;
}

.emoji-scroll::-webkit-scrollbar {
  width: 5px;
}

.emoji-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.emoji-scroll::-webkit-scrollbar-thumb {
  background: var(--color-fill-4, #e5e6eb);
  border-radius: 3px;
}

.emoji-grid {
  display: grid;
}

.emoji-item {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  border: none;
  background: transparent;
  padding: 0;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.emoji-item:active {
  background-color: var(--color-fill-4, #e5e6eb) !important;
}

.picker-emoji {
  flex-shrink: 0;
  object-fit: contain;
}

.emoji-fallback {
  font-size: 12px;
  color: var(--color-text-3, #86909c);
}
</style>
