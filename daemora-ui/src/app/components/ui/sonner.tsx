import { Toaster as Sonner, ToasterProps } from "sonner";

const Toaster = (props: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      closeButton
      style={
        {
          "--normal-bg": "#0f172a",
          "--normal-text": "#f0f0f3",
          "--normal-border": "#1e293b",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
