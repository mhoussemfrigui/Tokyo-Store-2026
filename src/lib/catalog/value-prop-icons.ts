import {
  Sparkles,
  Shield,
  ShieldCheck,
  Award,
  Star,
  Truck,
  Headphones,
  Tag,
  Globe2,
  Flame,
  Gift,
  Zap,
  Clock,
  Heart,
  Check,
  Package,
  CreditCard,
  Wrench,
  MapPin,
  Phone,
  Mail,
  MessageCircle,
  Store,
  Briefcase,
  Gem,
  Users,
  GraduationCap,
  Hourglass,
  UserRound,
  type LucideIcon,
} from "lucide-react";

/**
 * Curated icon set for the category/brand editorial "value-prop cards"
 * ({ icon, title, body }). Single source of truth shared by the storefront
 * renderer (CategoryEditorial) AND the admin ValuePropsEditor's visual picker,
 * so the pickable options can never drift from what actually renders. The
 * stored value is the `key` (a lucide component name); an unknown/empty key
 * falls back to Sparkles at render.
 */
export const VALUE_PROP_ICONS: { key: string; label: string; Icon: LucideIcon }[] = [
  { key: "Sparkles", label: "Étincelles", Icon: Sparkles },
  { key: "Shield", label: "Bouclier", Icon: Shield },
  { key: "ShieldCheck", label: "Garantie", Icon: ShieldCheck },
  { key: "Award", label: "Récompense", Icon: Award },
  { key: "Star", label: "Étoile", Icon: Star },
  { key: "Truck", label: "Livraison", Icon: Truck },
  { key: "Headphones", label: "Support", Icon: Headphones },
  { key: "Tag", label: "Étiquette", Icon: Tag },
  { key: "Globe2", label: "International", Icon: Globe2 },
  { key: "Flame", label: "Tendance", Icon: Flame },
  { key: "Gift", label: "Cadeau", Icon: Gift },
  { key: "Zap", label: "Rapidité", Icon: Zap },
  { key: "Clock", label: "Horloge", Icon: Clock },
  { key: "Heart", label: "Coup de cœur", Icon: Heart },
  { key: "Check", label: "Vérifié", Icon: Check },
  { key: "Package", label: "Colis", Icon: Package },
  { key: "CreditCard", label: "Paiement", Icon: CreditCard },
  { key: "Wrench", label: "Atelier / réparation", Icon: Wrench },
  { key: "MapPin", label: "Adresse", Icon: MapPin },
  { key: "Phone", label: "Téléphone", Icon: Phone },
  { key: "Mail", label: "E-mail", Icon: Mail },
  { key: "MessageCircle", label: "Message", Icon: MessageCircle },
  { key: "Store", label: "Boutique", Icon: Store },
  { key: "Briefcase", label: "Carrière", Icon: Briefcase },
  { key: "Gem", label: "Précieux", Icon: Gem },
  { key: "Users", label: "Équipe", Icon: Users },
  { key: "GraduationCap", label: "Formation", Icon: GraduationCap },
  { key: "Hourglass", label: "Temps", Icon: Hourglass },
  { key: "UserRound", label: "Compte", Icon: UserRound },
];

/** key → lucide component, for the storefront value-prop renderer. */
export const VALUE_PROP_ICON_MAP: Record<string, LucideIcon> = Object.fromEntries(
  VALUE_PROP_ICONS.map((o) => [o.key, o.Icon]),
);

/** Resolve a stored value-prop icon key to a component (Sparkles fallback). */
export function valuePropIcon(key: string | null | undefined): LucideIcon {
  // Own-key lookup only: a stored key like « constructor » / « __proto__ » must not
  // resolve to an Object.prototype member (rendering that as a component would crash).
  return (key && Object.hasOwn(VALUE_PROP_ICON_MAP, key) && VALUE_PROP_ICON_MAP[key]) || Sparkles;
}
