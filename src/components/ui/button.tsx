import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rh-neon/40 disabled:pointer-events-none disabled:opacity-40 active:scale-[0.98]",
  {
    variants: {
      variant: {
        default:
          "rounded-full bg-gradient-to-b from-rh-neon to-[#b8e000] text-rh-black shadow-neon hover:brightness-110",
        secondary:
          "rounded-full border border-white/10 bg-rh-elevated/90 text-rh-white hover:border-white/20 hover:bg-rh-line/60",
        ghost: "rounded-full text-rh-soft hover:bg-white/5 hover:text-rh-white",
        outline:
          "rounded-full border border-rh-line bg-transparent text-rh-white hover:border-rh-neon/40 hover:bg-rh-neon/5",
      },
      size: {
        default: "h-11 px-6 py-2",
        sm: "h-9 px-4 text-xs",
        lg: "h-12 px-8 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  ),
);
Button.displayName = "Button";
