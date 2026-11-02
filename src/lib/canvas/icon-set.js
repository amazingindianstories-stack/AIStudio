/**
 * The bundled icon set for board icons: lucide icons by kebab-case name. A board stores only the name and a
 * color, so recoloring is a one-field change and no third-party icon service is called.
 */
import {
  Activity, AlarmClock, Archive, ArrowRight, Award, Bell, Bookmark, Box, Briefcase, Bug, Calendar, Camera, Check, CheckCircle, Clock,
  Cloud, Code, Cog, Compass, CreditCard, Database, Download, Edit, Eye, File, FileText, Flag, Folder, Gift, Globe, GitBranch, Heart,
  HelpCircle, Home, Image, Inbox, Info, Key, Layers, Layout, Lightbulb, Link, List, Lock, Mail, Map, MapPin, MessageCircle, Mic,
  Monitor, Moon, Music, Package, Paperclip, Phone, PieChart, Play, Plus, Puzzle, Rocket, Search, Send, Server, Settings, Share2,
  Shield, ShoppingCart, Smartphone, Star, Sun, Tag, Target, Terminal, ThumbsUp, Trash2, TrendingUp, Trophy, User, Users, Video, Wallet,
  Wifi, Wrench, X, XCircle, Zap,
} from "lucide-react";

export const ICONS = {
  activity: Activity, "alarm-clock": AlarmClock, archive: Archive, "arrow-right": ArrowRight, award: Award, bell: Bell, bookmark: Bookmark,
  box: Box, briefcase: Briefcase, bug: Bug, calendar: Calendar, camera: Camera, check: Check, "check-circle": CheckCircle, clock: Clock,
  cloud: Cloud, code: Code, cog: Cog, compass: Compass, "credit-card": CreditCard, database: Database, download: Download, edit: Edit,
  eye: Eye, file: File, "file-text": FileText, flag: Flag, folder: Folder, gift: Gift, globe: Globe, "git-branch": GitBranch, heart: Heart,
  help: HelpCircle, home: Home, image: Image, inbox: Inbox, info: Info, key: Key, layers: Layers, layout: Layout, lightbulb: Lightbulb,
  link: Link, list: List, lock: Lock, mail: Mail, map: Map, "map-pin": MapPin, message: MessageCircle, mic: Mic, monitor: Monitor,
  moon: Moon, music: Music, package: Package, paperclip: Paperclip, phone: Phone, "pie-chart": PieChart, play: Play, plus: Plus,
  puzzle: Puzzle, rocket: Rocket, search: Search, send: Send, server: Server, settings: Settings, share: Share2, shield: Shield,
  cart: ShoppingCart, smartphone: Smartphone, star: Star, sun: Sun, tag: Tag, target: Target, terminal: Terminal, "thumbs-up": ThumbsUp,
  trash: Trash2, "trending-up": TrendingUp, trophy: Trophy, user: User, users: Users, video: Video, wallet: Wallet, wifi: Wifi,
  wrench: Wrench, x: X, "x-circle": XCircle, zap: Zap,
};

export const ICON_NAMES = Object.keys(ICONS);

/** Icons whose name contains every word of `query`. */
export function searchIcons(query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return ICON_NAMES.filter((name) => words.every((w) => name.includes(w)));
}

export const ICON_COLORS = ["#e5e7eb", "#f87171", "#fb923c", "#facc15", "#4ade80", "#38bdf8", "#818cf8", "#e879f9"];
